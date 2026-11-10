/**
 * Spec 024 §3.6 and §3.7 — the ledger: earnings lines, batch accrual, batch close, and refund
 * reconciliation.
 *
 * GLOBAL LOCK ORDER (§3.6), everywhere in this module:
 *   bookings → payments → refunds → provider_earnings_lines → earnings_adjustments → payouts → payout_items
 * ascending `id` within a table. A pass that discovers rows of an earlier table through a later one
 * reads the ids unlocked, then locks in global order, then re-validates under the locks.
 *
 * Exactly-once is STRUCTURAL: `UNIQUE (booking_id)` on lines; the partial unique indexes on
 * `payout_items` (one earnings item per line, one item per adjustment, one recovery per refund); the
 * conditional `reconciliation_state = 'pending'` update; and `payout_items_frozen_trg`.
 *
 * No rail call is made anywhere in this module.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { resolvePayoutProvider } from '@/lib/payments/provider/payout-factory';
import { payoutBatchCloseIntervalHours, payoutMinimumMinorUnits } from './config';
import { isDecryptableDestinationToken } from './destination-crypto';
import { evaluateEligibility, loadEligibilityFacts } from './eligibility';
import { computeLineFigures } from './fees';
import { getPayoutHoldGate } from './ports';
import { applyPayoutTransition } from './state-machine';

/** §3.3 — gross is the captured sum only, the exact query spec 022's `lib/refunds/amounts.ts` uses. */
export async function readCapturedGross(
  tx: Executor,
  paymentId: string,
): Promise<{ grossAmountMinorUnits: number; currencyCode: string | null }> {
  const [row] = await queryRows<{ captured: number | null; currency: string | null }>(
    tx,
    sql`SELECT (SELECT SUM(z.captured_amount_minor_units)::int FROM payment_authorizations z
                 WHERE z.payment_id = ${paymentId} AND z.captured_at IS NOT NULL) AS captured,
               (SELECT MAX(z.captured_currency_code) FROM payment_authorizations z
                 WHERE z.payment_id = ${paymentId} AND z.captured_at IS NOT NULL) AS currency`,
  );
  return { grossAmountMinorUnits: row?.captured ?? 0, currencyCode: row?.currency ?? null };
}

/** §3.3 — a refund enters `refundedTotal` only in the transaction that reconciles it. */
export async function readReconciledRefunded(tx: Executor, paymentId: string): Promise<number> {
  const [row] = await queryRows<{ total: number }>(
    tx,
    sql`SELECT COALESCE(SUM(total_amount_minor_units), 0)::int AS total FROM refunds
         WHERE payment_id = ${paymentId} AND status = 'completed' AND reconciliation_state = 'reconciled'`,
  );
  return row?.total ?? 0;
}

async function lockBookingAndPayment(
  tx: Executor,
  bookingId: string,
  options: { skipLocked: boolean },
): Promise<{ booking: { id: string; status: string; provider_profile_id: string; service_id: string }; payment: { id: string; status: string } } | null> {
  const lockClause = options.skipLocked ? sql`FOR UPDATE SKIP LOCKED` : sql`FOR UPDATE`;
  const [booking] = await queryRows<{ id: string; status: string; provider_profile_id: string; service_id: string }>(
    tx,
    sql`SELECT id, status, provider_profile_id, service_id FROM bookings WHERE id = ${bookingId} ${lockClause}`,
  );
  if (!booking) return null;
  const [payment] = await queryRows<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM payments WHERE booking_id = ${bookingId} FOR UPDATE`,
  );
  if (!payment) return null;
  return { booking, payment };
}

async function markRefundReconciled(tx: Executor, refundId: string): Promise<boolean> {
  const updated = await queryRows<{ id: string }>(
    tx,
    sql`UPDATE refunds SET reconciliation_state = 'reconciled', reconciled_at = clock_timestamp(),
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${refundId} AND status = 'completed' AND reconciliation_state = 'pending'
         RETURNING id`,
  );
  return updated.length > 0;
}

export type CreateLineOutcome = 'created' | 'exists' | 'skipped';

/**
 * §3.6 Pass A step 2 — one earnings line for one settled booking. Reconciles every completed refund
 * the payment already has (no recovery is needed: the line has no item yet), then snapshots the fee.
 */
export async function createEarningsLineForBooking(bookingId: string, feeBps: number): Promise<CreateLineOutcome> {
  try {
    return await getDb().transaction(async (tx) => {
      const locked = await lockBookingAndPayment(tx, bookingId, { skipLocked: true });
      if (!locked || locked.booking.status !== 'settled') return 'skipped';

      const [existing] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM provider_earnings_lines WHERE booking_id = ${bookingId}`,
      );
      if (existing) return 'exists';

      const { grossAmountMinorUnits, currencyCode } = await readCapturedGross(tx, locked.payment.id);
      if (grossAmountMinorUnits <= 0 || !currencyCode) return 'skipped';

      const pending = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM refunds WHERE payment_id = ${locked.payment.id} AND status = 'completed'
               AND reconciliation_state = 'pending' ORDER BY id FOR UPDATE`,
      );
      for (const refund of pending) await markRefundReconciled(tx, refund.id);

      const refunded = await readReconciledRefunded(tx, locked.payment.id);
      const figures = computeLineFigures(grossAmountMinorUnits, feeBps, refunded);

      await tx.execute(sql`
        INSERT INTO provider_earnings_lines (
          booking_id, provider_profile_id, payment_id, service_id, state,
          gross_amount_minor_units, gross_currency_code, platform_fee_bps,
          fee_amount_minor_units, fee_currency_code, refunded_amount_minor_units, refunded_currency_code,
          fee_reversal_amount_minor_units, fee_reversal_currency_code, net_amount_minor_units, net_currency_code
        ) VALUES (
          ${bookingId}, ${locked.booking.provider_profile_id}, ${locked.payment.id}, ${locked.booking.service_id}, 'pending',
          ${grossAmountMinorUnits}, ${currencyCode}, ${feeBps},
          ${figures.feeAmountMinorUnits}, ${currencyCode}, ${figures.refundedAmountMinorUnits}, ${currencyCode},
          ${figures.feeReversalAmountMinorUnits}, ${currencyCode}, ${figures.netAmountMinorUnits}, ${currencyCode}
        )
      `);

      console.log(JSON.stringify({ event: 'earnings.line_created', bookingId, providerProfileId: locked.booking.provider_profile_id, amountMinorUnits: figures.netAmountMinorUnits, status: 'pending' }));
      for (const refund of pending) {
        console.log(JSON.stringify({ event: 'earnings.refund_reconciled', refundId: refund.id, bookingId }));
      }
      return 'created';
    });
  } catch (err) {
    if (isUniqueViolation(err, 'provider_earnings_lines_booking_id_uq')) return 'exists';
    throw err;
  }
}

/** §3.6 Pass A step 3 — `pending → eligible` when E-1..E-5 hold under the booking and payment locks. */
export async function advanceLineEligibility(lineId: string, bookingId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const locked = await lockBookingAndPayment(tx, bookingId, { skipLocked: true });
    if (!locked) return false;
    const [line] = await queryRows<{ state: string }>(
      tx,
      sql`SELECT state FROM provider_earnings_lines WHERE id = ${lineId} FOR UPDATE`,
    );
    if (!line || line.state !== 'pending') return false;

    const facts = await loadEligibilityFacts(tx, bookingId);
    if (!facts || !evaluateEligibility(facts).eligible) return false;

    await tx.execute(sql`
      UPDATE provider_earnings_lines
         SET state = 'eligible', eligible_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${lineId} AND state = 'pending'
    `);
    console.log(JSON.stringify({ event: 'earnings.line_eligible', earningsLineId: lineId, bookingId, status: 'eligible' }));
    return true;
  });
}

/** The provider's single open `pending` batch for a currency, created if needed and locked (I-18). */
export async function lockOpenBatch(tx: Executor, providerProfileId: string, currencyCode: string): Promise<string> {
  const [existing] = await queryRows<{ id: string }>(
    tx,
    sql`SELECT id FROM payouts WHERE provider_profile_id = ${providerProfileId}
           AND payout_currency_code = ${currencyCode} AND status = 'pending' FOR UPDATE`,
  );
  if (existing) return existing.id;

  const providerName = resolvePayoutProvider().name;
  await tx.execute(sql`
    INSERT INTO payouts (provider_profile_id, status, payout_currency_code, payout_amount_minor_units, provider_name)
    VALUES (${providerProfileId}, 'pending', ${currencyCode}, 0, ${providerName})
    ON CONFLICT (provider_profile_id, payout_currency_code) WHERE status = 'pending' DO NOTHING
  `);
  const [row] = await queryRows<{ id: string }>(
    tx,
    sql`SELECT id FROM payouts WHERE provider_profile_id = ${providerProfileId}
           AND payout_currency_code = ${currencyCode} AND status = 'pending' FOR UPDATE`,
  );
  if (!row) throw new Error('open payout batch disappeared');
  console.log(JSON.stringify({ event: 'payout.batch_opened', payoutId: row.id, providerProfileId, status: 'pending' }));
  return row.id;
}

export async function recomputeBatchTotal(tx: Executor, payoutId: string): Promise<number> {
  const [row] = await queryRows<{ total: number }>(
    tx,
    sql`UPDATE payouts
           SET payout_amount_minor_units = (SELECT COALESCE(SUM(item_amount_minor_units), 0)::int FROM payout_items WHERE payout_id = ${payoutId}),
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${payoutId} AND status = 'pending'
         RETURNING payout_amount_minor_units AS total`,
  );
  return row?.total ?? 0;
}

/** §3.6 Pass B — attaches one eligible line to its provider's open batch at the line's current net. */
export async function accrueLine(lineId: string, bookingId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const locked = await lockBookingAndPayment(tx, bookingId, { skipLocked: true });
    if (!locked) return false;
    const [line] = await queryRows<{ state: string; provider_profile_id: string; net_amount_minor_units: number; net_currency_code: string }>(
      tx,
      sql`SELECT state, provider_profile_id, net_amount_minor_units, net_currency_code
            FROM provider_earnings_lines WHERE id = ${lineId} FOR UPDATE`,
    );
    if (!line || line.state !== 'eligible') return false;

    const [attached] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM payout_items WHERE earnings_line_id = ${lineId} AND kind = 'earnings_line'`,
    );
    if (attached) return false;

    const facts = await loadEligibilityFacts(tx, bookingId);
    if (!facts || !evaluateEligibility(facts).eligible) {
      await tx.execute(sql`
        UPDATE provider_earnings_lines SET state = 'pending', eligible_at = NULL, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${lineId} AND state = 'eligible'
      `);
      return false;
    }

    const payoutId = await lockOpenBatch(tx, line.provider_profile_id, line.net_currency_code);
    await tx.execute(sql`
      INSERT INTO payout_items (payout_id, kind, earnings_line_id, item_amount_minor_units, item_currency_code)
      VALUES (${payoutId}, 'earnings_line', ${lineId}, ${line.net_amount_minor_units}, ${line.net_currency_code})
    `);
    await recomputeBatchTotal(tx, payoutId);
    return true;
  });
}

/** §3.6 Pass B — attaches one applied, unattached adjustment to its provider's open batch. */
export async function accrueAdjustment(adjustmentId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [adjustment] = await queryRows<{ provider_profile_id: string; adjustment_amount_minor_units: number; adjustment_currency_code: string; applied_at: Date | null }>(
      tx,
      sql`SELECT provider_profile_id, adjustment_amount_minor_units, adjustment_currency_code, applied_at
            FROM earnings_adjustments WHERE id = ${adjustmentId} FOR UPDATE SKIP LOCKED`,
    );
    if (!adjustment || !adjustment.applied_at) return false;
    const [attached] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM payout_items WHERE adjustment_id = ${adjustmentId} AND kind = 'adjustment'`,
    );
    if (attached) return false;

    const payoutId = await lockOpenBatch(tx, adjustment.provider_profile_id, adjustment.adjustment_currency_code);
    await tx.execute(sql`
      INSERT INTO payout_items (payout_id, kind, adjustment_id, item_amount_minor_units, item_currency_code)
      VALUES (${payoutId}, 'adjustment', ${adjustmentId}, ${adjustment.adjustment_amount_minor_units}, ${adjustment.adjustment_currency_code})
    `);
    await recomputeBatchTotal(tx, payoutId);
    return true;
  });
}

/** §3.6 Pass C — the provider's usable default method in a currency, or null. */
export async function findUsableDefaultMethod(
  tx: Executor,
  providerProfileId: string,
  currencyCode: string,
): Promise<{ id: string } | null> {
  const rows = await queryRows<{ id: string; destination_token_encrypted: string }>(
    tx,
    sql`SELECT id, destination_token_encrypted FROM payout_methods
         WHERE provider_profile_id = ${providerProfileId} AND payout_currency_code = ${currencyCode}
           AND is_default AND removed_at IS NULL AND verification_state = 'verified'`,
  );
  const row = rows[0];
  if (!row || !isDecryptableDestinationToken(row.destination_token_encrypted)) return null;
  return { id: row.id };
}

export async function isProviderAccountDeleted(tx: Executor, providerProfileId: string): Promise<boolean> {
  const [row] = await queryRows<{ lifecycle_status: string }>(
    tx,
    sql`SELECT u.lifecycle_status FROM provider_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.id = ${providerProfileId}`,
  );
  return !row || row.lifecycle_status === 'deleted';
}

export type CloseOutcome = 'closed' | 'not_due' | 'not_positive' | 'held' | 'account_closed' | 'no_payout_method' | 'skipped';

/**
 * §3.6 Pass C — closes one `pending` batch to `eligible`, re-verifying every attached line under the
 * global lock order and detaching any that no longer qualifies.
 */
export async function closeBatch(payoutId: string, options?: { ignoreInterval?: boolean }): Promise<CloseOutcome> {
  const lineRefs = await queryRows<{ earnings_line_id: string; booking_id: string; payment_id: string }>(
    getDb(),
    sql`SELECT i.earnings_line_id, l.booking_id, l.payment_id
          FROM payout_items i JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
         WHERE i.payout_id = ${payoutId} AND i.kind = 'earnings_line'`,
  );

  const result = await getDb().transaction(async (tx): Promise<{ outcome: CloseOutcome; providerProfileId?: string; amount?: number }> => {
    const bookingIds = [...new Set(lineRefs.map((r) => r.booking_id))].sort();
    const paymentIds = [...new Set(lineRefs.map((r) => r.payment_id))].sort();
    const lineIds = lineRefs.map((r) => r.earnings_line_id).sort();

    for (const id of bookingIds) await tx.execute(sql`SELECT id FROM bookings WHERE id = ${id} FOR UPDATE`);
    for (const id of paymentIds) await tx.execute(sql`SELECT id FROM payments WHERE id = ${id} FOR UPDATE`);
    for (const id of lineIds) await tx.execute(sql`SELECT id FROM provider_earnings_lines WHERE id = ${id} FOR UPDATE`);

    const [payout] = await queryRows<{ status: string; provider_profile_id: string; payout_currency_code: string; due: boolean }>(
      tx,
      sql`SELECT status, provider_profile_id, payout_currency_code,
                 (created_at <= clock_timestamp() - make_interval(hours => ${payoutBatchCloseIntervalHours()})) AS due
            FROM payouts WHERE id = ${payoutId} FOR UPDATE SKIP LOCKED`,
    );
    if (!payout || payout.status !== 'pending') return { outcome: 'skipped' };

    // Re-verify the attached set: it must be exactly what we locked, and every line must still qualify.
    const current = await queryRows<{ earnings_line_id: string; booking_id: string }>(
      tx,
      sql`SELECT i.earnings_line_id, l.booking_id FROM payout_items i JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
           WHERE i.payout_id = ${payoutId} AND i.kind = 'earnings_line'`,
    );
    if (current.some((row) => !lineIds.includes(row.earnings_line_id))) return { outcome: 'skipped' };

    for (const row of current) {
      const facts = await loadEligibilityFacts(tx, row.booking_id);
      if (facts && evaluateEligibility(facts).eligible) continue;
      await tx.execute(sql`DELETE FROM payout_items WHERE payout_id = ${payoutId} AND earnings_line_id = ${row.earnings_line_id} AND kind = 'earnings_line'`);
      await tx.execute(sql`
        UPDATE provider_earnings_lines SET state = 'pending', eligible_at = NULL, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${row.earnings_line_id} AND state = 'eligible'
      `);
      console.log(JSON.stringify({ event: 'payout.line_detached', payoutId, earningsLineId: row.earnings_line_id, status: 'pending' }));
    }
    const total = await recomputeBatchTotal(tx, payoutId);

    if (!payout.due && !options?.ignoreInterval) return { outcome: 'not_due' };
    if (total <= 0 || total < payoutMinimumMinorUnits()) return { outcome: 'not_positive' };
    if ((await getPayoutHoldGate()(tx, payout.provider_profile_id)).held) {
      return { outcome: 'held', providerProfileId: payout.provider_profile_id };
    }
    if (await isProviderAccountDeleted(tx, payout.provider_profile_id)) return { outcome: 'account_closed' };

    const method = await findUsableDefaultMethod(tx, payout.provider_profile_id, payout.payout_currency_code);
    if (!method) return { outcome: 'no_payout_method' };

    const providerName = resolvePayoutProvider().name;
    const applied = await applyPayoutTransition(tx, {
      payoutId,
      from: 'pending',
      to: 'eligible',
      actorRole: 'system',
      actorUserId: null,
      set: sql`, closed_at = clock_timestamp(), payout_method_id = ${method.id}, provider_name = ${providerName}`,
    });
    return applied ? { outcome: 'closed', providerProfileId: payout.provider_profile_id, amount: total } : { outcome: 'skipped' };
  });

  if (result.outcome === 'closed') {
    console.log(JSON.stringify({ event: 'payout.batch_closed', payoutId, providerProfileId: result.providerProfileId, amountMinorUnits: result.amount, status: 'eligible' }));
  } else if (result.outcome === 'held') {
    console.log(JSON.stringify({ event: 'payout.batch_held', payoutId, providerProfileId: result.providerProfileId, status: 'pending' }));
  }
  return result.outcome;
}

export type ReconcileOutcome = 'noop' | 'no_line' | 'reduced_in_place' | 'detached' | 'recovery_created' | 'no_change';

/**
 * §3.7 — consumes ONE spec 022 refund fact, exactly once. Uses only the refund id: every figure is
 * re-read under lock, never taken from an event payload.
 */
export async function reconcileRefund(refundId: string): Promise<ReconcileOutcome> {
  const [ref] = await queryRows<{ booking_id: string; payment_id: string }>(
    getDb(),
    sql`SELECT booking_id, payment_id FROM refunds WHERE id = ${refundId}`,
  );
  if (!ref) return 'noop';

  try {
    const outcome = await getDb().transaction(async (tx): Promise<ReconcileOutcome> => {
      const locked = await lockBookingAndPayment(tx, ref.booking_id, { skipLocked: false });
      if (!locked) return 'noop';

      const [refund] = await queryRows<{ status: string; reconciliation_state: string }>(
        tx,
        sql`SELECT status, reconciliation_state FROM refunds WHERE id = ${refundId} FOR UPDATE`,
      );
      if (!refund || refund.status !== 'completed' || refund.reconciliation_state !== 'pending') return 'noop';

      const [line] = await queryRows<{
        id: string;
        state: string;
        provider_profile_id: string;
        gross_amount_minor_units: number;
        platform_fee_bps: number;
        net_amount_minor_units: number;
        net_currency_code: string;
      }>(
        tx,
        sql`SELECT id, state, provider_profile_id, gross_amount_minor_units, platform_fee_bps, net_amount_minor_units, net_currency_code
              FROM provider_earnings_lines WHERE booking_id = ${ref.booking_id} FOR UPDATE`,
      );

      if (!(await markRefundReconciled(tx, refundId))) return 'noop';
      if (!line) return 'no_line';

      const [item] = await queryRows<{ id: string; payout_id: string }>(
        tx,
        sql`SELECT id, payout_id FROM payout_items WHERE earnings_line_id = ${line.id} AND kind = 'earnings_line'`,
      );
      let itemPayoutStatus: string | null = null;
      if (item) {
        const [payout] = await queryRows<{ status: string }>(
          tx,
          sql`SELECT status FROM payouts WHERE id = ${item.payout_id} FOR UPDATE`,
        );
        itemPayoutStatus = payout?.status ?? null;
      }

      const refunded = await readReconciledRefunded(tx, ref.payment_id);
      const figures = computeLineFigures(line.gross_amount_minor_units, line.platform_fee_bps, refunded);
      const delta = line.net_amount_minor_units - figures.netAmountMinorUnits;

      await tx.execute(sql`
        UPDATE provider_earnings_lines
           SET refunded_amount_minor_units = ${figures.refundedAmountMinorUnits},
               fee_reversal_amount_minor_units = ${figures.feeReversalAmountMinorUnits},
               net_amount_minor_units = ${figures.netAmountMinorUnits},
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${line.id}
      `);

      if (!item) {
        if (line.state === 'eligible') {
          await tx.execute(sql`
            UPDATE provider_earnings_lines SET state = 'pending', eligible_at = NULL, updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${line.id} AND state = 'eligible'
          `);
        }
        return 'reduced_in_place';
      }

      if (itemPayoutStatus === 'pending') {
        await tx.execute(sql`DELETE FROM payout_items WHERE id = ${item.id}`);
        await recomputeBatchTotal(tx, item.payout_id);
        await tx.execute(sql`
          UPDATE provider_earnings_lines SET state = 'pending', eligible_at = NULL, updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${line.id} AND state = 'eligible'
        `);
        return 'detached';
      }

      if (delta <= 0) return 'no_change';

      const openBatchId = await lockOpenBatch(tx, line.provider_profile_id, line.net_currency_code);
      await tx.execute(sql`
        INSERT INTO payout_items (payout_id, kind, earnings_line_id, source_refund_id, item_amount_minor_units, item_currency_code)
        VALUES (${openBatchId}, 'refund_recovery', ${line.id}, ${refundId}, ${-delta}, ${line.net_currency_code})
      `);
      await recomputeBatchTotal(tx, openBatchId);
      console.log(JSON.stringify({ event: 'payout.recovery_created', payoutId: openBatchId, earningsLineId: line.id, refundId, amountMinorUnits: -delta, status: 'pending' }));
      return 'recovery_created';
    });

    if (outcome !== 'noop') {
      console.log(JSON.stringify({ event: 'earnings.refund_reconciled', refundId, bookingId: ref.booking_id, status: outcome }));
    }
    return outcome;
  } catch (err) {
    // A concurrent reconciliation of the same refund lost the race on the unique recovery index:
    // the winner already applied the effect, so this is a no-op, not an error.
    if (isUniqueViolation(err, 'payout_items_source_refund_uq')) return 'noop';
    throw err;
  }
}
