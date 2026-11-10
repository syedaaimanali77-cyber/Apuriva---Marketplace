/**
 * Spec 031 §3 (AC-7) and the closing half of "Financial ownership" (AC-2, DECIDED-5).
 *
 * CLOSURE IS THE ONE PLACE MONEY IS HANDED BACK. It mirrors `create.ts` exactly:
 *
 *   1. lock `disputes` → `bookings` → `payments` `FOR UPDATE` — the same order, extended;
 *   2. re-read the refund position UNDER THOSE LOCKS and refuse if it is not terminal;
 *   3. move the dispute to `closed`, the booking `disputed -> protected` (spec 020's primitive) and
 *      the protection `disputed -> held` (spec 021's primitive).
 *
 * Spec 021's sweep then releases and settles exactly as it always would. If the protection window
 * elapsed during the dispute, that happens on the very next tick — so a provider is paid promptly
 * once the argument ends, without this spec computing anything about the payout.
 *
 * WHY THE REFUND MUST BE TERMINAL FIRST. A dispute that closed while a refund was `requested`,
 * `processing` (including spec 022's deliberately-sticky `unknown` outcome) or never initiated
 * would release the payout for money that is simultaneously on its way back to the customer. That
 * is the one state this spec exists to make impossible, so closure refuses with `422
 * DISPUTE_REFUND_PENDING` and spec 022's reconciliation sweep resolves it.
 *
 * A COMPLETED FULL REFUND NEEDS NO BOOKING TRANSITION. Spec 022 has already moved the booking to
 * `refunded` on its own authority, so there is nothing to hand back: the gate answering `closed` is
 * the whole of closure. `disputed -> protected` is attempted only when the booking is still
 * `disputed`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { applyBookingTransition } from '@/lib/bookings/state-machine';
import { setProtectionState } from '@/lib/payments/record';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentProtectionState } from '@/lib/types/payments';
import type { DisputeRefundState, DisputeStatus } from '@/lib/types/disputes';
import { disputeNotFoundError, disputeRefundPendingError } from './errors';
import { auditDispute, DISPUTE_EVENT_TYPES, loadResolutionRow, resolveRefundState } from './read';
import { isCloseable } from './transitions';
import { emitToBothParties } from './notifications';

/** Refund states that permit closure. `proposed` and `initiated` deliberately do not. */
const TERMINAL_REFUND_STATES: readonly DisputeRefundState[] = ['none', 'completed', 'failed'];

export function isRefundTerminal(state: DisputeRefundState): boolean {
  return TERMINAL_REFUND_STATES.includes(state);
}

export interface CloseOptions {
  /** `null` for the sweep — a system action with no acting human. */
  actorUserId: string | null;
  correlationId?: string | null;
  /**
   * When true, a non-terminal refund is not an error: closure is skipped and reported, leaving the
   * caller's own work (an appeal decision) recorded. The sweep closes it later.
   */
  tolerateRefundPending?: boolean;
}

export type CloseResult =
  | { closed: true }
  | { closed: false; reason: 'not_closeable' | 'refund_pending' | 'lost_race'; refundState?: DisputeRefundState };

interface LockedCloseFacts {
  status: DisputeStatus;
  bookingId: string;
  bookingStatus: BookingStatus;
  bookingVersion: number;
  paymentId: string | null;
  protectionState: PaymentProtectionState | null;
  paymentVersion: number;
  customerUserId: string;
  providerUserId: string;
}

async function lockForClose(tx: Executor, disputeId: string): Promise<LockedCloseFacts | null> {
  const [dispute] = await queryRows<{ status: DisputeStatus; booking_id: string }>(
    tx,
    sql`SELECT status, booking_id FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
  );
  if (!dispute) return null;

  const [booking] = await queryRows<{
    id: string;
    status: BookingStatus;
    version: number;
    customer_user_id: string;
    provider_user_id: string;
  }>(
    tx,
    sql`SELECT b.id, b.status, b.version, cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${dispute.booking_id}
           FOR UPDATE OF b`,
  );
  if (!booking) return null;

  const [payment] = await queryRows<{ id: string; protection_state: PaymentProtectionState | null; version: number }>(
    tx,
    sql`SELECT id, protection_state, version FROM payments WHERE booking_id = ${dispute.booking_id} FOR UPDATE`,
  );

  return {
    status: dispute.status,
    bookingId: dispute.booking_id,
    bookingStatus: booking.status,
    bookingVersion: booking.version,
    paymentId: payment?.id ?? null,
    protectionState: payment?.protection_state ?? null,
    paymentVersion: payment?.version ?? 0,
    customerUserId: booking.customer_user_id,
    providerUserId: booking.provider_user_id,
  };
}

/**
 * AC-7 — closes one dispute, returning the booking and the payment to spec 021's care.
 *
 * Returns rather than throwing for the sweep's benefit: a dispute that another closer won, or whose
 * refund is still moving, is skipped silently rather than failing a batch. The route-facing paths
 * (`waive-appeal`) turn a `refund_pending` result into the `422` the API contract promises.
 */
export async function closeDispute(disputeId: string, options: CloseOptions): Promise<CloseResult> {
  const db = getDb();

  const resolution = await loadResolutionRow(db, disputeId);
  const refundState = await resolveRefundState(db, resolution);
  if (!isRefundTerminal(refundState)) {
    if (options.tolerateRefundPending) return { closed: false, reason: 'refund_pending', refundState };
    throw disputeRefundPendingError(refundState);
  }

  let parties: { customerUserId: string; providerUserId: string } | null = null;
  let bookingReturned = false;

  const outcome = await db.transaction(async (tx): Promise<CloseResult> => {
    const facts = await lockForClose(tx, disputeId);
    if (!facts) throw disputeNotFoundError();
    if (!isCloseable(facts.status)) return { closed: false, reason: 'not_closeable' };

    // Re-read the refund position under the locks. The check above was advisory; this one is
    // authoritative, and it is what makes a concurrent refund completion safe.
    const lockedResolution = await loadResolutionRow(tx, disputeId);
    const lockedRefundState = await resolveRefundState(tx, lockedResolution);
    if (!isRefundTerminal(lockedRefundState)) {
      if (options.tolerateRefundPending) return { closed: false, reason: 'refund_pending', refundState: lockedRefundState };
      throw disputeRefundPendingError(lockedRefundState);
    }

    const moved = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE disputes
             SET status = 'closed', closed_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${disputeId} AND status IN ('resolved','appealed')
           RETURNING id`,
    );
    if (moved.length === 0) return { closed: false, reason: 'lost_race' };

    // Hand the booking back — but only if it is still ours to hand back. A completed FULL refund
    // has already moved it to `refunded` on spec 022's authority, and that is correct: there is
    // nothing to return.
    if (facts.bookingStatus === 'disputed') {
      // ALWAYS `system`, even when a human triggered the closure. Spec 020's `BookingActorRole` is
      // `customer | provider | system`, and returning a booking to `protected` is not an act by
      // either party — it is the platform restoring the state the dispute suspended. The human who
      // caused it is captured on the `disputes.closed` audit event instead, where their role and
      // reason belong. `bookings_status_history_actor_pairing_ck` requires `actorUserId` to be null
      // exactly when the role is `system`, so the two travel together.
      const returned = await applyBookingTransition(tx, {
        bookingId: facts.bookingId,
        from: 'disputed',
        to: 'protected',
        actorRole: 'system',
        actorUserId: null,
        expectedVersion: facts.bookingVersion,
      });
      if (!returned.applied) throw disputeNotFoundError();
      bookingReturned = true;
    }

    // Hand the protection back, so spec 021's sweep resumes releasing and settling.
    if (facts.paymentId && facts.protectionState === 'disputed') {
      await setProtectionState(tx, {
        paymentId: facts.paymentId,
        from: 'disputed',
        to: 'held',
        expectedVersion: facts.paymentVersion,
      });
    }

    parties = { customerUserId: facts.customerUserId, providerUserId: facts.providerUserId };
    return { closed: true };
  });

  if (!outcome.closed) return outcome;

  // After commit only.
  const actor = options.actorUserId;
  if (actor !== null) {
    await auditDispute({
      actorUserId: actor,
      eventType: DISPUTE_EVENT_TYPES.closed,
      targetId: disputeId,
      correlationId: options.correlationId ?? null,
      details: { refundState, bookingReturned },
    });
    if (bookingReturned) {
      await auditDispute({
        actorUserId: actor,
        eventType: DISPUTE_EVENT_TYPES.payoutHoldReleased,
        targetId: disputeId,
        correlationId: options.correlationId ?? null,
      });
    }
    if (refundState === 'failed') {
      // Spec 022 owns the retry and the Finance alert; this only records that the dispute closed
      // knowing the refund had failed, so the two records cannot silently disagree.
      await auditDispute({
        actorUserId: actor,
        eventType: DISPUTE_EVENT_TYPES.refundFailed,
        targetId: disputeId,
        correlationId: options.correlationId ?? null,
      });
    }
  }

  if (parties) await emitToBothParties('dispute_closed', disputeId, parties);
  return { closed: true };
}

export interface DisputeAppealSweepResult {
  examined: number;
  closed: number;
  refundPending: number;
}

/**
 * The appeal-expiry sweep (DECIDED-11), run by `/api/v1/cron/dispute-appeal-sweep`.
 *
 * Closes every `resolved` dispute whose appeal window has elapsed and whose refund position is
 * terminal. AC-7 needs a mover for the deadline, and every other deadline in this repository has a
 * sweep — this is that sweep and it introduces no new scheduling framework.
 *
 * It sets NO outcome and decides NOTHING: an unappealed decision simply becomes final. A dispute
 * whose refund is still moving is counted and left alone for the next run.
 */
export async function runDisputeAppealSweep(): Promise<DisputeAppealSweepResult> {
  const { disputeAppealWindowDays } = await import('./limits');
  const days = disputeAppealWindowDays();

  const candidates = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT d.id
          FROM disputes d
          JOIN dispute_resolutions r ON r.dispute_id = d.id
         WHERE d.status = 'resolved'
           AND r.resolved_at <= clock_timestamp() - make_interval(days => ${days})
         ORDER BY r.resolved_at ASC
         LIMIT 200`,
  );

  const result: DisputeAppealSweepResult = { examined: candidates.length, closed: 0, refundPending: 0 };
  for (const candidate of candidates) {
    const outcome = await closeDispute(candidate.id, { actorUserId: null, tolerateRefundPending: true });
    if (outcome.closed) result.closed += 1;
    else if (outcome.reason === 'refund_pending') result.refundPending += 1;
  }
  return result;
}

/**
 * A participant ends the appeal window early (DECIDED-11).
 *
 * Without this, closure depends solely on the sweep, and a party who accepts the outcome has no way
 * to release the provider's money sooner. Waiving is one-sided on purpose: whoever waives gives up
 * only their own right to appeal, and because at most one appeal exists per dispute, a waiver by
 * either party while none is filed makes the decision final.
 */
export async function waiveAppeal(disputeId: string, userId: string, correlationId: string | null): Promise<CloseResult> {
  const { resolveParticipantAccess } = await import('./read');
  const ownership = await resolveParticipantAccess(disputeId, userId);
  if (ownership.status !== 'resolved') return { closed: false, reason: 'not_closeable' };
  return closeDispute(disputeId, { actorUserId: userId, correlationId });
}
