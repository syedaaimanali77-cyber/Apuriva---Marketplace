/**
 * Spec 020 §3 "Unilateral-completion safeguards" (AC-5, AC-8, AC-9, AC-11).
 *
 * AC-8 stands exactly as approved: EITHER the customer OR the provider may mark an `in_progress`
 * booking `completed`, without the other party's confirmation. Nothing in this module requires,
 * waits for, or infers the other party's agreement — there is no confirmation flag anywhere.
 *
 * What stops that becoming an unrestricted shortcut is S1–S9, all state-machine rules:
 *   S1 only from `in_progress`      S4 no pre-emptive start (enforced in lifecycle.ts)
 *   S2 participant + matching mode  S5 symmetric evidence gate
 *   S3 minimum in-progress dwell    S6 mandatory append-only attribution
 *   S7 both parties see it at once  S8 `completed` is terminal here  S9 CSRF + limit + key
 *
 * VALIDATION ORDER IS NORMATIVE (AC-9). Session and CSRF happen in the route; this module runs
 * (3) participant + active-mode match, (4) key presence (route), (5) status, (6) dwell,
 * (7) evidence gate, and only THEN (8) the concurrency-safe conditional update. A request failing
 * any of (1)–(7) is rejected on its own merits EVEN IF the other party's concurrent request has
 * already completed the booking — losing the race is an idempotent success only for a request that
 * would otherwise have succeeded.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { BookingDto, BookingStatus } from '@/lib/types/bookings';
import { getCompletionEvidenceGate } from './completion-evidence';
import {
  bookingVersionConflictError,
  completionEvidenceRequiredError,
  completionTooEarlyError,
  invalidStatusTransitionError,
} from './errors';
import { loadBookingDto, requireBookingParticipant } from './read';
import { applyBookingTransition, isTransitionCheckViolation, MIN_IN_PROGRESS_SECONDS } from './state-machine';

/**
 * Marks an `in_progress` booking `completed` on behalf of whichever participant called.
 *
 * `actingAs` is the caller's ACTIVE MODE. Participation resolution requires the caller actually to
 * be that party, so the `actor_role` written to history is never ambiguous even for a user who
 * holds both a customer and a provider profile on one booking.
 */
export async function completeBooking(
  userId: string,
  bookingId: string,
  actingAs: 'customer' | 'provider',
): Promise<BookingDto> {
  // (3) participant resolution + active-mode match. Throws 404 for a non-participant, and for a
  // participant acting in the other party's mode — never a free pass because of a concurrent call.
  const { booking, role } = await requireBookingParticipant(userId, bookingId, actingAs);

  // (5) status. `completed` is accepted so a retry (or the loser of AC-9's race) can be an
  // idempotent success; every OTHER status is rejected on its own merits.
  //
  // NOTE: an already-`completed` booking is deliberately NOT short-circuited here. Returning early
  // would let a caller who fails the dwell (6) or the evidence gate (7) ride on the winner's
  // transition — precisely the free pass AC-9 forbids. The checks below therefore run for every
  // caller, and only a request that passes ALL of them is reported as an idempotent success.
  if (booking.status !== 'in_progress' && booking.status !== 'completed') {
    throw invalidStatusTransitionError(booking.status);
  }

  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);

      const [locked] = await queryRows<{ status: BookingStatus; version: number }>(
        tx,
        sql`SELECT status, version FROM bookings WHERE id = ${bookingId}`,
      );
      if (!locked) throw invalidStatusTransitionError(booking.status);

      // Re-check (5) under the lock. A booking that moved on is rejected; one already `completed`
      // still has to clear (6) and (7) below before it is reported as an idempotent success, so an
      // evidence-incomplete or too-early caller never rides on the winner's transition.
      if (locked.status !== 'in_progress' && locked.status !== 'completed') {
        throw invalidStatusTransitionError(locked.status);
      }

      // (6) AC-11 / S3 — the dwell, on the DATABASE clock, read after the lock is held. Never
      // `now()` (frozen at transaction start) and never a client clock.
      await assertDwellElapsed(tx, bookingId);

      // (7) AC-5 / S5 — the evidence gate, consulted identically for both parties.
      const evidence = await getCompletionEvidenceGate()(tx, bookingId);
      if (evidence.required && !evidence.satisfied) throw completionEvidenceRequiredError();

      // The loser of AC-9's race arrives here having passed every check on its own merits.
      if (locked.status === 'completed') return;

      // (8) the concurrency-safe transition: conditional on (status, version), so of two
      // simultaneous valid completions exactly one writes exactly one history row.
      const result = await applyBookingTransition(tx, {
        bookingId,
        from: 'in_progress',
        to: 'completed',
        actorRole: role,
        actorUserId: userId,
        expectedVersion: locked.version,
      });
      if (!result.applied) {
        if (result.currentStatus === 'completed') return; // lost the race, having passed every check.
        if (result.currentStatus !== 'in_progress') throw invalidStatusTransitionError(result.currentStatus);
        throw bookingVersionConflictError(result.currentVersion);
      }
    });
  } catch (err) {
    // AC-6: the spec 003 trigger is the independent second line of defence; map its 23514 onto the
    // same `409 INVALID_STATUS_TRANSITION`, never a 500.
    if (isTransitionCheckViolation(err)) throw invalidStatusTransitionError(booking.status);
    throw err;
  }

  return loadBookingDto(bookingId);
}

/**
 * S3 — rejects until `MIN_IN_PROGRESS_SECONDS` of database time have elapsed since the
 * `arrived -> in_progress` history row. Symmetric: the same rule applies to whichever party calls.
 *
 * A booking with no such history row (impossible through this spec's routes, since `in_progress` is
 * only ever reached by writing one) is treated as having satisfied the dwell rather than being
 * permanently un-completable.
 */
async function assertDwellElapsed(tx: Parameters<typeof applyBookingTransition>[0], bookingId: string): Promise<void> {
  const [row] = await queryRows<{ remaining: number | null }>(
    tx,
    sql`SELECT CEIL(EXTRACT(EPOCH FROM (
                 h.occurred_at + make_interval(secs => ${MIN_IN_PROGRESS_SECONDS}) - clock_timestamp()
               )))::int AS remaining
          FROM bookings_status_history h
         WHERE h.booking_id = ${bookingId} AND h.to_status = 'in_progress'
         ORDER BY h.occurred_at DESC
         LIMIT 1`,
  );
  const remaining = row?.remaining ?? 0;
  if (remaining > 0) {
    console.log(JSON.stringify({ event: 'booking.completion_too_early', bookingId, retryAfterSeconds: remaining }));
    throw completionTooEarlyError(remaining);
  }
}
