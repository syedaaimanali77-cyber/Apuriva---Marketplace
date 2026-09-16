/**
 * Spec 024 §3.6 / §3.7 / §3.8 — `/api/v1/cron/payout-sweep`, scheduled `*\/5 * * * *` in vercel.json.
 *
 * The existing Vercel Cron mechanism; no worker process. Each pass is bounded (`LIMIT 200`) and
 * idempotent — the next run is the continuation — and each item is its own transaction, so one bad
 * row never stops the rest. Order:
 *   pull-reconcile refunds → A. create lines → A. advance eligibility → B. accrue →
 *   automatic retries → C. close batches → D. transfer → revoke removed methods → alerts
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { PayoutProviderUnavailable } from '@/lib/payments/provider/payout-factory';
import { PAYOUT_SWEEP_BATCH_LIMIT, payoutNegativeBalanceAlertDays, payoutStalePendingHours } from './config';
import { PlatformFeeUnconfigured, resolvePlatformFeeBps } from './fees';
import {
  accrueAdjustment,
  accrueLine,
  advanceLineEligibility,
  closeBatch,
  createEarningsLineForBooking,
  reconcileRefund,
} from './ledger';
import { revokePendingRemovedMethods } from './payout-methods';
import { scopeFilter, type PayoutSweepScope } from './sweep-scope';
import { retryFailedPayoutsAutomatically, transferPayout } from './transfer';

export interface PayoutSweepResult {
  refundsReconciled: number;
  linesCreated: number;
  linesEligible: number;
  linesAccrued: number;
  adjustmentsAccrued: number;
  retried: number;
  batchesClosed: number;
  transfersPaid: number;
  transfersFailed: number;
  transfersUnknown: number;
  methodsRevoked: number;
  feeUnconfigured: boolean;
  railUnavailable: boolean;
}

function logPassError(pass: string, id: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'error';
  console.error(JSON.stringify({ event: 'payout.sweep_item_failed', pass, id, error: name }));
}

export async function runPayoutSweep(scope?: PayoutSweepScope): Promise<PayoutSweepResult> {
  const result: PayoutSweepResult = {
    refundsReconciled: 0,
    linesCreated: 0,
    linesEligible: 0,
    linesAccrued: 0,
    adjustmentsAccrued: 0,
    retried: 0,
    batchesClosed: 0,
    transfersPaid: 0,
    transfersFailed: 0,
    transfersUnknown: 0,
    methodsRevoked: 0,
    feeUnconfigured: false,
    railUnavailable: false,
  };

  const noteRail = (err: unknown): boolean => {
    if (err instanceof PayoutProviderUnavailable) {
      result.railUnavailable = true;
      return true;
    }
    return false;
  };

  // §3.7 pull — the durable source of truth for refund reconciliation.
  const refunds = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT r.id FROM refunds r JOIN bookings b ON b.id = r.booking_id
         WHERE r.status = 'completed' AND r.reconciliation_state = 'pending' ${scopeFilter(sql`b.provider_profile_id`, scope)}
         ORDER BY r.completed_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const refund of refunds) {
    try {
      if ((await reconcileRefund(refund.id)) !== 'noop') result.refundsReconciled += 1;
    } catch (err) {
      if (!noteRail(err)) logPassError('reconcile', refund.id, err);
    }
  }

  // Pass A — one line per settled booking. Never on a guessed fee.
  let feeBps: number | null = null;
  try {
    feeBps = resolvePlatformFeeBps();
  } catch (err) {
    if (!(err instanceof PlatformFeeUnconfigured)) throw err;
    result.feeUnconfigured = true;
    console.error(JSON.stringify({ event: 'earnings.fee_unconfigured', action: 'set PLATFORM_FEE_BPS; no earnings line is created until then' }));
  }
  if (feeBps !== null) {
    const bookings = await queryRows<{ id: string }>(
      getDb(),
      sql`SELECT b.id FROM bookings b
           WHERE b.status = 'settled' ${scopeFilter(sql`b.provider_profile_id`, scope)} AND NOT EXISTS (SELECT 1 FROM provider_earnings_lines l WHERE l.booking_id = b.id)
           ORDER BY b.updated_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
    );
    for (const booking of bookings) {
      try {
        if ((await createEarningsLineForBooking(booking.id, feeBps)) === 'created') result.linesCreated += 1;
      } catch (err) {
        logPassError('create_line', booking.id, err);
      }
    }
  }

  const pendingLines = await queryRows<{ id: string; booking_id: string }>(
    getDb(),
    sql`SELECT id, booking_id FROM provider_earnings_lines WHERE state = 'pending' ${scopeFilter(sql`provider_profile_id`, scope)} ORDER BY created_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const line of pendingLines) {
    try {
      if (await advanceLineEligibility(line.id, line.booking_id)) result.linesEligible += 1;
    } catch (err) {
      logPassError('eligibility', line.id, err);
    }
  }

  // Pass B — accrual into the open batch.
  const unattachedLines = await queryRows<{ id: string; booking_id: string }>(
    getDb(),
    sql`SELECT l.id, l.booking_id FROM provider_earnings_lines l
         WHERE l.state = 'eligible' ${scopeFilter(sql`l.provider_profile_id`, scope)} AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.earnings_line_id = l.id AND i.kind = 'earnings_line')
         ORDER BY l.eligible_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const line of unattachedLines) {
    try {
      if (await accrueLine(line.id, line.booking_id)) result.linesAccrued += 1;
    } catch (err) {
      if (!noteRail(err)) logPassError('accrue_line', line.id, err);
    }
  }
  const unattachedAdjustments = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT a.id FROM earnings_adjustments a
         WHERE a.applied_at IS NOT NULL ${scopeFilter(sql`a.provider_profile_id`, scope)} AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.adjustment_id = a.id AND i.kind = 'adjustment')
         ORDER BY a.applied_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const adjustment of unattachedAdjustments) {
    try {
      if (await accrueAdjustment(adjustment.id)) result.adjustmentsAccrued += 1;
    } catch (err) {
      if (!noteRail(err)) logPassError('accrue_adjustment', adjustment.id, err);
    }
  }

  try {
    result.retried = await retryFailedPayoutsAutomatically(scope);
  } catch (err) {
    logPassError('retry', 'batch', err);
  }

  // Pass C — close due batches.
  const openBatches = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM payouts WHERE status = 'pending' ${scopeFilter(sql`provider_profile_id`, scope)} ORDER BY created_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const batch of openBatches) {
    try {
      if ((await closeBatch(batch.id)) === 'closed') result.batchesClosed += 1;
    } catch (err) {
      if (!noteRail(err)) logPassError('close', batch.id, err);
    }
  }

  // Pass D — transfers. A missing rail stops here and changes nothing.
  const eligible = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM payouts WHERE status = 'eligible' ${scopeFilter(sql`provider_profile_id`, scope)} ORDER BY closed_at ASC LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const payout of eligible) {
    try {
      const outcome = await transferPayout(payout.id);
      if (outcome === 'paid') result.transfersPaid += 1;
      else if (outcome === 'failed') result.transfersFailed += 1;
      else if (outcome === 'unknown') result.transfersUnknown += 1;
    } catch (err) {
      if (noteRail(err)) break;
      logPassError('transfer', payout.id, err);
    }
  }

  try {
    result.methodsRevoked = await revokePendingRemovedMethods(scope);
  } catch (err) {
    if (!noteRail(err)) logPassError('revoke', 'batch', err);
  }

  await raiseAlerts();
  if (result.railUnavailable) {
    console.error(JSON.stringify({ event: 'payout.rail_unavailable', action: 'configure PAYOUT_PROVIDER; no payout was changed' }));
  }
  return result;
}

/** §9 alerts — structured log lines only; they never change state. */
async function raiseAlerts(): Promise<void> {
  const stale = await queryRows<{ id: string; provider_profile_id: string }>(
    getDb(),
    sql`SELECT id, provider_profile_id FROM payouts
         WHERE status = 'pending' AND created_at < clock_timestamp() - make_interval(hours => ${payoutStalePendingHours()})
         LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const row of stale) {
    console.error(JSON.stringify({ event: 'payout.stale_pending', payoutId: row.id, providerProfileId: row.provider_profile_id, status: 'pending' }));
  }

  const negative = await queryRows<{ id: string; provider_profile_id: string; payout_amount_minor_units: number }>(
    getDb(),
    sql`SELECT p.id, p.provider_profile_id, p.payout_amount_minor_units FROM payouts p
         WHERE p.status = 'pending' AND p.payout_amount_minor_units < 0
           AND EXISTS (SELECT 1 FROM payout_items i WHERE i.payout_id = p.id AND i.kind = 'refund_recovery'
                        AND i.created_at < clock_timestamp() - make_interval(days => ${payoutNegativeBalanceAlertDays()}))
         LIMIT ${PAYOUT_SWEEP_BATCH_LIMIT}`,
  );
  for (const row of negative) {
    console.error(JSON.stringify({ event: 'payout.negative_balance_outstanding', payoutId: row.id, providerProfileId: row.provider_profile_id, amountMinorUnits: row.payout_amount_minor_units, status: 'pending' }));
  }
}

export { runPayoutReconcileSweep, type PayoutReconcileResult } from './transfer';
export type { PayoutSweepScope } from './sweep-scope';
