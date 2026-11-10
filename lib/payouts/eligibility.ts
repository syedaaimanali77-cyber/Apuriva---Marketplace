/**
 * Spec 024 §3.4 "Eligibility" (AC-1) — spec 021's semantics, unchanged.
 *
 * No protection duration exists in this spec. Spec 021's sweep decides `released`; this module only
 * reads the resulting state together with spec 022's refund facts. The pure evaluator is what the
 * unit suite exercises; `loadEligibilityFacts` reads the same facts under the caller's locks.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';

export interface EligibilityFacts {
  protectionState: string | null;
  bookingStatus: string;
  paymentStatus: string;
  /** Refunds on the payment in `requested` or `processing`. */
  inFlightRefunds: number;
  /** `completed` refunds on the payment whose `reconciliation_state` is still `pending`. */
  unreconciledRefunds: number;
}

export type IneligibilityReason =
  | 'protection_not_released'
  | 'booking_not_settled'
  | 'payment_not_payable'
  | 'refund_in_flight'
  | 'refund_unreconciled';

export type EligibilityResult = { eligible: true } | { eligible: false; reason: IneligibilityReason };

export function evaluateEligibility(facts: EligibilityFacts): EligibilityResult {
  if (facts.protectionState !== 'released') return { eligible: false, reason: 'protection_not_released' };
  if (facts.bookingStatus !== 'settled') return { eligible: false, reason: 'booking_not_settled' };
  if (facts.paymentStatus !== 'captured' && facts.paymentStatus !== 'partially_refunded') {
    return { eligible: false, reason: 'payment_not_payable' };
  }
  if (facts.inFlightRefunds > 0) return { eligible: false, reason: 'refund_in_flight' };
  if (facts.unreconciledRefunds > 0) return { eligible: false, reason: 'refund_unreconciled' };
  return { eligible: true };
}

/** Reads E-1..E-5 for one booking. Call only while holding the booking and payment locks. */
export async function loadEligibilityFacts(tx: Executor, bookingId: string): Promise<EligibilityFacts | null> {
  const [row] = await queryRows<{
    protection_state: string | null;
    booking_status: string;
    payment_status: string;
    in_flight: number;
    unreconciled: number;
  }>(
    tx,
    sql`SELECT p.protection_state, b.status AS booking_status, p.status AS payment_status,
               (SELECT COUNT(*)::int FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('requested','processing')) AS in_flight,
               (SELECT COUNT(*)::int FROM refunds r WHERE r.payment_id = p.id AND r.status = 'completed'
                                                     AND r.reconciliation_state = 'pending') AS unreconciled
          FROM bookings b JOIN payments p ON p.booking_id = b.id
         WHERE b.id = ${bookingId}`,
  );
  if (!row) return null;
  return {
    protectionState: row.protection_state,
    bookingStatus: row.booking_status,
    paymentStatus: row.payment_status,
    inFlightRefunds: row.in_flight,
    unreconciledRefunds: row.unreconciled,
  };
}
