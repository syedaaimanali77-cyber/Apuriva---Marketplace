/**
 * Spec 023 §3 "The financial boundary" (AC-7) — the decision spec 022 executes.
 *
 * This is the implementation of spec 022's `RefundEligibilityGate`, which that spec shipped with an
 * inert `{ eligible: false }` default explicitly waiting for this one. Registering it here keeps the
 * dependency direction spec 022 designed for: 023 decides, 022 executes, and neither reaches into
 * the other's tables.
 *
 * The gate is a READ of a decision already committed by `lib/cancellation/cancel.ts`. It computes
 * nothing, so it cannot disagree with what the customer was shown and what the audit row records —
 * and because spec 022 consults it inside its own transaction under the payment row lock, there is
 * no window in which a decision read earlier could be acted on later.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { RefundEligibility } from '@/lib/refunds/eligibility';

/** The reason recorded verbatim on the refund line, derived from the tier that applied. */
export function cancellationRefundReason(feePercent: number): string {
  return `cancellation_tier_${feePercent}`;
}

/**
 * Spec 022 calls this with `(tx, bookingId)`.
 *
 * `{ eligible: false }` covers three distinct situations, all correct:
 *   - the booking was never cancelled through this spec (nothing to refund);
 *   - the tier consumed the whole captured amount (`refund_amount_minor_units = 0`) — a 100% fee is
 *     "nothing is owed", which spec 022's contract expresses as ineligible rather than a zero refund;
 *   - the decision row is somehow unreadable, in which case refusing is the only safe answer.
 */
export async function cancellationRefundEligibility(tx: Executor, bookingId: string): Promise<RefundEligibility> {
  const [row] = await queryRows<{
    refund_amount_minor_units: number;
    captured_currency_code: string;
    tier_fee_percent: number;
    decision_ref: string;
  }>(
    tx,
    sql`SELECT refund_amount_minor_units, captured_currency_code, tier_fee_percent, decision_ref
          FROM booking_cancellations WHERE booking_id = ${bookingId}`,
  );

  if (!row || row.refund_amount_minor_units <= 0) return { eligible: false };

  return {
    eligible: true,
    amountMinorUnits: row.refund_amount_minor_units,
    currencyCode: row.captured_currency_code,
    reason: cancellationRefundReason(row.tier_fee_percent),
    decisionRef: row.decision_ref,
  };
}
