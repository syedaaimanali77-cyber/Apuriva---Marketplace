/**
 * Spec 031 §3 "Financial ownership" (AC-2, DECIDED-5) — the `DisputeGate` implementation.
 *
 * THIS FILE IS THE WHOLE OF THE PAYOUT HOLD. Spec 021 shipped the port
 * (`lib/payments/protection-window.ts`) with an inert default answering "no booking is ever
 * disputed", and its own comment says "Spec 031 registers the real gate when it ships". This is
 * that gate, and it is four lines of query:
 *
 *     dispute not closed
 *       └─▶ { open: true }
 *             └─▶ spec 021 nextProtectionState() → 'disputed'
 *                   └─▶ spec 024 evaluateEligibility() → protection_not_released
 *                         └─▶ no payout row is created
 *
 * NOTHING HERE TOUCHES PAYOUTS. There is no `payouts` query, no `PayoutHoldGate` registration (that
 * slot is spec 038's and stays empty), and no amount arithmetic. The hold is achieved entirely
 * through a state spec 021 already owns and spec 024 already refuses to pay out from, which is why
 * AC-2 is structural rather than a rule this spec has to remember to apply.
 *
 * It reads inside the CALLER'S transaction (`tx`), so the answer is taken under whatever locks the
 * payment sweep is already holding. There is no window in which a release could act on a stale
 * "not disputed".
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { DisputeGate } from '@/lib/payments/protection-window';

/**
 * True while any dispute on the booking is not `closed`.
 *
 * `closed` is the single financially-final state (`lib/disputes/transitions.ts`), so a merely
 * RESOLVED dispute still answers `open: true` — that is what holds the money through the appeal
 * window and makes AC-4's "the money stays held" true without a second mechanism.
 */
export const disputeGate: DisputeGate = async (tx: Executor, bookingId: string) => {
  const rows = await queryRows<{ id: string }>(
    tx,
    sql`SELECT id FROM disputes WHERE booking_id = ${bookingId} AND status <> 'closed' LIMIT 1`,
  );
  return { open: rows.length > 0 };
};
