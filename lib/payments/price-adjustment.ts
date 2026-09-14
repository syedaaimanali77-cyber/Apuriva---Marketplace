/**
 * Spec 021 §3 "Price adjustments" (AC-3, AC-4) — propose, approve, reject, charge.
 *
 * The rule master spec §46 and §132.15 state, and the one this module exists to make structural:
 * **never silently charge a changed amount.** A provider proposes; the row is `pending_approval`
 * and charges nothing. The customer approves; approval and charge are bound to the SAME row, so
 * the amount charged is necessarily the amount that was shown. There is no other code path that
 * can charge an adjustment.
 *
 * `bookings.price_amount_minor_units` / `price_currency_code` are NEVER rewritten here — spec 020
 * owns those columns and `bookings_terms_immutable_trg` enforces it at the database. An adjustment
 * is this spec's own entity, not an edit to the agreed booking price.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { queryRows, isUniqueViolation, type Executor } from '@/lib/offers/db';
import { requireBookingParticipant } from '@/lib/bookings';
import type { PriceAdjustmentDto, PriceAdjustmentStatus } from '@/lib/types/payments';
import {
  adjustmentAlreadyResolvedError,
  adjustmentApprovalRequiredError,
  adjustmentCurrencyMismatchError,
  idempotencyKeyConflictError,
  paymentFailedError,
  paymentNotFoundError,
} from './errors';
import { resolvePaymentProvider } from './provider';
import { loadPriceAdjustmentDto, requireAdjustmentParticipant } from './read';
import { recordAttempt } from './record';

const MAX_REASON_LENGTH = 500;

export interface ProposePriceAdjustmentInput {
  additionalAmountMinorUnits: number;
  additionalCurrencyCode: string;
  reason: string;
}

function parseProposal(body: unknown): ProposePriceAdjustmentInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];

  const amount = input.additionalAmountMinorUnits;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    errors.push({ field: 'additionalAmountMinorUnits', message: 'must be an integer number of minor units' });
  } else if (amount <= 0) {
    errors.push({ field: 'additionalAmountMinorUnits', message: 'must be greater than zero' });
  }

  const currency = typeof input.additionalCurrencyCode === 'string' ? input.additionalCurrencyCode.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push({ field: 'additionalCurrencyCode', message: 'must be a three-letter ISO-4217 code' });
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) errors.push({ field: 'reason', message: 'is required' });
  else if (reason.length > MAX_REASON_LENGTH) {
    errors.push({ field: 'reason', message: `must be at most ${MAX_REASON_LENGTH} characters` });
  }

  if (errors.length > 0) throw validationError(errors);
  return { additionalAmountMinorUnits: amount as number, additionalCurrencyCode: currency, reason };
}

/**
 * AC-4 step 1 — the provider proposes. Charges nothing, contacts no provider adapter, and fixes the
 * exact amount and currency the customer will be shown.
 */
export async function proposePriceAdjustment(
  userId: string,
  bookingId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ adjustment: PriceAdjustmentDto; created: boolean }> {
  const { booking } = await requireBookingParticipant(userId, bookingId, 'provider');
  const parsed = parseProposal(body);

  if (parsed.additionalCurrencyCode !== booking.currencyCode) {
    throw adjustmentCurrencyMismatchError(booking.currencyCode, parsed.additionalCurrencyCode);
  }

  const fingerprint = idempotencyFingerprint({
    bookingId,
    additionalAmountMinorUnits: parsed.additionalAmountMinorUnits,
    additionalCurrencyCode: parsed.additionalCurrencyCode,
    reason: parsed.reason,
  });

  const [providerProfile] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM provider_profiles WHERE user_id = ${userId}`,
  );
  if (!providerProfile) throw paymentNotFoundError();

  let adjustmentId = '';
  let created = false;

  const insert = async () => {
    await getDb().transaction(async (tx) => {
      const [existing] = await queryRows<{ id: string; idempotency_fingerprint: string }>(
        tx,
        sql`SELECT id, idempotency_fingerprint FROM price_adjustments
             WHERE booking_id = ${bookingId} AND idempotency_key = ${idempotencyKey} FOR UPDATE`,
      );
      if (existing) {
        if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
        adjustmentId = existing.id;
        return;
      }

      const inserted = await queryRows<{ id: string }>(
        tx,
        sql`INSERT INTO price_adjustments (
              booking_id, additional_amount_minor_units, additional_currency_code, reason, status,
              proposed_by_user_id, idempotency_key, idempotency_fingerprint
            ) VALUES (
              ${bookingId}, ${parsed.additionalAmountMinorUnits}, ${parsed.additionalCurrencyCode},
              ${parsed.reason}, 'pending_approval', ${userId}, ${idempotencyKey}, ${fingerprint}
            ) RETURNING id`,
      );
      adjustmentId = inserted[0]!.id;
      created = true;
    });
  };

  try {
    await insert();
  } catch (err) {
    if (isUniqueViolation(err, 'price_adjustments_booking_idempotency_key_uq')) await insert();
    else throw err;
  }

  return { adjustment: await loadPriceAdjustmentDto(adjustmentId), created };
}

interface LockedAdjustment {
  id: string;
  booking_id: string;
  status: PriceAdjustmentStatus;
  version: number;
  additional_amount_minor_units: number;
  additional_currency_code: string;
}

async function lockAdjustment(tx: Executor, adjustmentId: string): Promise<LockedAdjustment> {
  const [row] = await queryRows<LockedAdjustment>(
    tx,
    sql`SELECT id, booking_id, status, version, additional_amount_minor_units, additional_currency_code
          FROM price_adjustments WHERE id = ${adjustmentId} FOR UPDATE`,
  );
  if (!row) throw paymentNotFoundError();
  return row;
}

/**
 * AC-4 step 3 — the customer approves, and ONLY THEN is the additional amount charged.
 *
 * Approval is a conditional update predicated on `status = 'pending_approval'` AND the `version`
 * the caller read, so of two concurrent approvals exactly one wins; the loser gets `409
 * ADJUSTMENT_ALREADY_RESOLVED` and NO adapter call is made on its path (§3 "Idempotency and
 * concurrency"). The provider call happens after that transaction commits, never inside it.
 */
export async function approvePriceAdjustment(
  userId: string,
  adjustmentId: string,
  idempotencyKey: string,
): Promise<PriceAdjustmentDto> {
  const { adjustment, bookingId } = await requireAdjustmentParticipant(userId, adjustmentId, 'customer');

  if (adjustment.status === 'charged') return adjustment; // idempotent: already done.
  if (adjustment.status !== 'pending_approval') throw adjustmentAlreadyResolvedError(adjustment.status);

  const provider = resolvePaymentProvider();

  let approved: LockedAdjustment | null = null;
  await getDb().transaction(async (tx) => {
    const locked = await lockAdjustment(tx, adjustmentId);
    if (locked.status === 'charged') return;
    if (locked.status !== 'pending_approval') throw adjustmentAlreadyResolvedError(locked.status);

    const updated = await queryRows<{ id: string; version: number }>(
      tx,
      sql`UPDATE price_adjustments
             SET status = 'approved', approved_by_user_id = ${userId}, approved_at = clock_timestamp(),
                 updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${adjustmentId} AND status = 'pending_approval' AND version = ${locked.version}
           RETURNING id, version`,
    );
    if (updated.length === 0) throw adjustmentAlreadyResolvedError('approved');
    approved = { ...locked, version: updated[0]!.version, status: 'approved' };
  });

  if (!approved) return loadPriceAdjustmentDto(adjustmentId);
  const row = approved as LockedAdjustment;

  return chargeApprovedAdjustment({ userId, bookingId, adjustment: row, idempotencyKey, provider });
}

/**
 * AC-4 — the charge, gated on an `approved` row.
 *
 * Exported so `chargeRemainder()` and any future caller share exactly one charging path; it refuses
 * outright if the row it is handed is not approved, so the gate cannot be bypassed by calling it
 * directly.
 */
async function chargeApprovedAdjustment(input: {
  userId: string;
  bookingId: string;
  adjustment: LockedAdjustment;
  idempotencyKey: string;
  provider: ReturnType<typeof resolvePaymentProvider>;
}): Promise<PriceAdjustmentDto> {
  const { userId, bookingId, adjustment, idempotencyKey, provider } = input;
  if (adjustment.status !== 'approved') throw adjustmentApprovalRequiredError();

  const [payment] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM payments WHERE booking_id = ${bookingId}`,
  );

  const result = await provider.authorize({
    idempotencyKey: `${idempotencyKey}:adjustment:${adjustment.id}`,
    amountMinorUnits: adjustment.additional_amount_minor_units,
    currencyCode: adjustment.additional_currency_code,
    reference: adjustment.id,
  });

  const succeeded = result.outcome === 'authorized' || result.outcome === 'captured';

  await getDb().transaction(async (tx) => {
    const locked = await lockAdjustment(tx, adjustment.id);
    if (locked.status === 'charged') return;

    if (payment) {
      await recordAttempt(tx, {
        paymentId: payment.id,
        status: succeeded ? 'succeeded' : 'failed',
        providerReference: result.providerReference,
        failureCode: succeeded ? null : (result.failureCode ?? 'declined'),
        failureReason: succeeded ? null : (result.failureMessage ?? null),
      });
    }

    await tx.execute(sql`
      UPDATE price_adjustments
         SET status = ${succeeded ? 'charged' : 'failed'},
             payment_id = ${succeeded && payment ? payment.id : null},
             updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${adjustment.id} AND version = ${locked.version}
    `);
  });

  if (!succeeded) throw paymentFailedError(result.failureCode);

  console.log(
    JSON.stringify({
      event: 'price_adjustment.charged',
      adjustmentId: adjustment.id,
      bookingId,
      amountMinorUnits: adjustment.additional_amount_minor_units,
      currencyCode: adjustment.additional_currency_code,
    }),
  );
  void userId;
  return loadPriceAdjustmentDto(adjustment.id);
}

/** AC-4 step 4 — the negative branch, without which "explicit approval" would be meaningless. */
export async function rejectPriceAdjustment(userId: string, adjustmentId: string): Promise<PriceAdjustmentDto> {
  const { adjustment } = await requireAdjustmentParticipant(userId, adjustmentId, 'customer');
  if (adjustment.status === 'rejected') return adjustment;
  if (adjustment.status !== 'pending_approval') throw adjustmentAlreadyResolvedError(adjustment.status);

  await getDb().transaction(async (tx) => {
    const locked = await lockAdjustment(tx, adjustmentId);
    if (locked.status === 'rejected') return;
    if (locked.status !== 'pending_approval') throw adjustmentAlreadyResolvedError(locked.status);

    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE price_adjustments
             SET status = 'rejected', updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${adjustmentId} AND status = 'pending_approval' AND version = ${locked.version}
           RETURNING id`,
    );
    if (updated.length === 0) throw adjustmentAlreadyResolvedError('resolved');
  });

  return loadPriceAdjustmentDto(adjustmentId);
}

/**
 * AC-3 — the deposit remainder.
 *
 * Unreachable today because no service can resolve to `deposit_then_remainder` (see `timing.ts`),
 * but its substantive rule is enforced and tested now: the remainder is charged only through an
 * `approved` adjustment row, so it can never be taken silently. Handed an unapproved row — or no
 * row at all — it refuses with `422 ADJUSTMENT_APPROVAL_REQUIRED`.
 */
export async function chargeRemainder(
  userId: string,
  bookingId: string,
  adjustmentId: string,
  idempotencyKey: string,
): Promise<PriceAdjustmentDto> {
  const provider = resolvePaymentProvider();
  const [row] = await queryRows<LockedAdjustment>(
    getDb(),
    sql`SELECT id, booking_id, status, version, additional_amount_minor_units, additional_currency_code
          FROM price_adjustments WHERE id = ${adjustmentId} AND booking_id = ${bookingId}`,
  );
  if (!row) throw adjustmentApprovalRequiredError();
  if (row.status !== 'approved') throw adjustmentApprovalRequiredError();
  return chargeApprovedAdjustment({ userId, bookingId, adjustment: row, idempotencyKey, provider });
}
