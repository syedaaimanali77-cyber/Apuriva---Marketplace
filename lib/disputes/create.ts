/**
 * Spec 031 §3 "Dispute eligibility" (AC-1) and the opening half of "Financial ownership" (AC-2).
 *
 * ONE TRANSACTION, THREE WRITES, AND NO MONEY MOVES:
 *
 *   1. lock `bookings` then `payments` `FOR UPDATE` — spec 022's established order, extended;
 *   2. check eligibility UNDER THOSE LOCKS (`protected` + `held`), so the boundary is exact;
 *   3. insert the `disputes` row, move the booking `protected -> disputed` through spec 020's
 *      primitive, and move the protection `held -> disputed` through spec 021's primitive.
 *
 * WHY THE PROTECTION STATE IS SET HERE AND NOT LEFT TO THE SWEEP. Spec 021's sweep would set it on
 * its next tick anyway, via the `DisputeGate` — but "anyway, in up to five minutes" is a window in
 * which a payout could be created for money that is now under argument. Setting it inside the same
 * transaction that creates the dispute closes that window entirely. It is spec 021's own exported,
 * version-guarded primitive; no amount, no capture and no provider call is involved.
 *
 * A LOST RACE IS `422`, NOT A RETRY. `setProtectionState` returning `false` means another writer
 * won under the lock, and the only writer that could have is the sweep releasing the window. The
 * window really has closed, so the whole transaction rolls back and the caller is told the booking
 * is no longer disputable — which is the truth, not a transient failure.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { applyBookingTransition } from '@/lib/bookings/state-machine';
import { setProtectionState } from '@/lib/payments/record';
import { isUuid } from '@/lib/offers/validation';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentProtectionState } from '@/lib/types/payments';
import type { DisputeDto } from '@/lib/types/disputes';
import { disputeAlreadyOpenError, disputeNotEligibleError, disputeNotFoundError } from './errors';
import { auditDispute, DISPUTE_EVENT_TYPES, getDisputeForParticipant } from './read';
import { summarizeForTriage } from './ai-assist';
import { emitDisputeNotification } from './notifications';
import type { ParsedOpenDispute } from './validation';

/** The booking status a dispute may be opened from, and the one it moves to. */
export const DISPUTE_ELIGIBLE_BOOKING_STATUS: BookingStatus = 'protected';
export const DISPUTED_BOOKING_STATUS: BookingStatus = 'disputed';
export const DISPUTE_ELIGIBLE_PROTECTION_STATE: PaymentProtectionState = 'held';

export interface EligibilityFacts {
  bookingStatus: BookingStatus;
  protectionState: PaymentProtectionState | null;
  hasLiveDispute: boolean;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: 'booking_not_protected' | 'protection_not_held' | 'dispute_already_open' };

/**
 * The pure predicate behind AC-1, so the boundary is unit-testable without a database.
 *
 * Deliberately narrow. `completed` is excluded even though it precedes `protected`: it is transient
 * (spec 021's sweep moves `completed -> protected` and opens the window in the same pass) and has
 * no `protection_state` to hold, so a dispute opened there would freeze nothing. `settled`,
 * `cancelled`, `refunded` and `failed` are excluded because the money has already left, been
 * returned, or never arrived.
 */
export function evaluateDisputeEligibility(facts: EligibilityFacts): EligibilityResult {
  if (facts.hasLiveDispute) return { eligible: false, reason: 'dispute_already_open' };
  if (facts.bookingStatus !== DISPUTE_ELIGIBLE_BOOKING_STATUS) return { eligible: false, reason: 'booking_not_protected' };
  if (facts.protectionState !== DISPUTE_ELIGIBLE_PROTECTION_STATE) return { eligible: false, reason: 'protection_not_held' };
  return { eligible: true };
}

interface LockedFacts extends EligibilityFacts {
  bookingVersion: number;
  paymentId: string;
  paymentVersion: number;
  customerUserId: string;
  providerUserId: string;
  liveDisputeId: string | null;
}

/** Reads AC-1's facts with `bookings` and `payments` already locked, in that order. */
async function lockAndLoad(tx: Executor, bookingId: string): Promise<LockedFacts | null> {
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
         WHERE b.id = ${bookingId}
           FOR UPDATE OF b`,
  );
  if (!booking) return null;

  const [payment] = await queryRows<{ id: string; protection_state: PaymentProtectionState | null; version: number }>(
    tx,
    sql`SELECT id, protection_state, version FROM payments WHERE booking_id = ${bookingId} FOR UPDATE`,
  );

  const [live] = await queryRows<{ id: string }>(
    tx,
    sql`SELECT id FROM disputes WHERE booking_id = ${bookingId} AND status <> 'closed' LIMIT 1`,
  );

  return {
    bookingStatus: booking.status,
    bookingVersion: booking.version,
    protectionState: payment?.protection_state ?? null,
    paymentId: payment?.id ?? '',
    paymentVersion: payment?.version ?? 0,
    hasLiveDispute: Boolean(live),
    liveDisputeId: live?.id ?? null,
    customerUserId: booking.customer_user_id,
    providerUserId: booking.provider_user_id,
  };
}

export interface OpenDisputeResult {
  dispute: DisputeDto;
  replayed: boolean;
}

/**
 * AC-1 + AC-2 — opens a dispute.
 *
 * The caller has already been established as a participant by the route
 * (`requireBookingParticipant`), which answers `404` for anyone else, so a non-participant can
 * never reach this function.
 */
export async function openDispute(
  userId: string,
  bookingId: string,
  input: ParsedOpenDispute,
  idempotency: { key: string; fingerprint: string },
): Promise<OpenDisputeResult> {
  if (!isUuid(bookingId)) throw disputeNotFoundError();
  const db = getDb();

  // Idempotent replay, checked before the locks: a retry of a request that already succeeded must
  // not take write locks on a booking and a payment.
  const [existing] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM disputes WHERE opened_by_user_id = ${userId} AND idempotency_key = ${idempotency.key}`,
  );
  if (existing) {
    return { dispute: await getDisputeForParticipant(existing.id, userId), replayed: true };
  }

  let disputeId: string;
  let counterpartyUserId: string;

  try {
    const result = await db.transaction(async (tx) => {
      const facts = await lockAndLoad(tx, bookingId);
      if (!facts) throw disputeNotFoundError();

      const eligibility = evaluateDisputeEligibility(facts);
      if (!eligibility.eligible) {
        if (eligibility.reason === 'dispute_already_open') throw disputeAlreadyOpenError(facts.liveDisputeId ?? undefined);
        throw disputeNotEligibleError();
      }

      const [row] = await queryRows<{ id: string }>(
        tx,
        sql`INSERT INTO disputes (booking_id, opened_by_user_id, status, reason, idempotency_key, idempotency_fingerprint)
            VALUES (${bookingId}, ${userId}, 'open', ${input.reason}, ${idempotency.key}, ${idempotency.fingerprint})
            RETURNING id`,
      );
      const newDisputeId = row!.id;

      // Spec 020's primitive, for a transition spec 031 owns and seeds. Never a raw UPDATE.
      const moved = await applyBookingTransition(tx, {
        bookingId,
        from: DISPUTE_ELIGIBLE_BOOKING_STATUS,
        to: DISPUTED_BOOKING_STATUS,
        actorRole: facts.customerUserId === userId ? 'customer' : 'provider',
        actorUserId: userId,
        expectedVersion: facts.bookingVersion,
      });
      if (!moved.applied) throw disputeNotEligibleError();

      // Spec 021's primitive. THIS is the payout hold — see `lib/disputes/gate.ts` for the chain.
      const held = await setProtectionState(tx, {
        paymentId: facts.paymentId,
        from: 'held',
        to: 'disputed',
        expectedVersion: facts.paymentVersion,
      });
      if (!held) throw disputeNotEligibleError();

      return {
        disputeId: newDisputeId,
        counterpartyUserId: facts.customerUserId === userId ? facts.providerUserId : facts.customerUserId,
      };
    });
    disputeId = result.disputeId;
    counterpartyUserId = result.counterpartyUserId;
  } catch (err) {
    // The partial unique index is the real concurrency authority: two simultaneous opens produce
    // exactly one dispute, and the loser is told so rather than seeing a raw constraint error.
    if (isUniqueViolation(err, 'disputes_booking_open_uq')) throw disputeAlreadyOpenError();
    if (isUniqueViolation(err, 'disputes_opener_idempotency_uq')) {
      const [row] = await queryRows<{ id: string }>(
        db,
        sql`SELECT id FROM disputes WHERE opened_by_user_id = ${userId} AND idempotency_key = ${idempotency.key}`,
      );
      if (row) return { dispute: await getDisputeForParticipant(row.id, userId), replayed: true };
    }
    throw err;
  }

  // Everything below is AFTER COMMIT and cannot affect the dispute's existence.

  await auditDispute({
    actorUserId: userId,
    eventType: DISPUTE_EVENT_TYPES.opened,
    targetId: disputeId,
    reason: input.reason,
    details: { bookingId },
  });
  // The payout seam, recorded on both sides so the hold and its release are separately auditable.
  await auditDispute({
    actorUserId: userId,
    eventType: DISPUTE_EVENT_TYPES.payoutHoldApplied,
    targetId: disputeId,
    details: { bookingId },
  });

  // Advisory only (AC-6). Stored in its own column; no decision anywhere reads it.
  const summary = await summarizeForTriage({ reason: input.reason });
  if (summary !== null) {
    await db.execute(sql`UPDATE disputes SET ai_summary = ${summary}, updated_at = clock_timestamp() WHERE id = ${disputeId}`);
  }

  await emitDisputeNotification({ kind: 'dispute_opened', disputeId, recipientUserId: counterpartyUserId });

  return { dispute: await getDisputeForParticipant(disputeId, userId), replayed: false };
}
