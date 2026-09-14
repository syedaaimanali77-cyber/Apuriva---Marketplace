/**
 * Spec 020 §3 "Lifecycle transitions" — the booking state machine.
 *
 * This module is the ONE way any spec changes `bookings.status`. Nothing anywhere — in this spec or
 * in a later one — writes that column with its own SQL. Spec 021 calls `applyBookingTransition()`
 * for `completed -> protected` and `protected -> settled` with `actorRole: 'system'`; spec 023,
 * 031 and 022 do the same for their own transitions, each seeding its own
 * `bookings_status_transitions` rows in its own migration.
 *
 * PAYMENT BOUNDARY (§3): this file, and every file under `lib/bookings/**`, reads no payment state
 * and imports no payment module. `protected` and `settled` appear here only as members of the
 * vocabulary — no spec 020 code path transitions into them, and `SPEC_020_TRANSITIONS` below
 * deliberately contains neither. `lib/bookings/payment-boundary.test.ts` asserts this at the source
 * level so the boundary cannot rot.
 *
 * Timing is always the DATABASE clock (`clock_timestamp()`), read in a statement issued AFTER the
 * relevant row lock is held — never `now()` (frozen at transaction start) and never a client clock.
 * That is the rule spec 018 established for offer expiry, and AC-11's guards depend on it.
 */
import { sql } from 'drizzle-orm';
import { BOOKING_STATUSES } from '@/lib/db/schema';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { BookingActorRole, BookingStatus } from '@/lib/types/bookings';

export { BOOKING_STATUSES };
export type { BookingActorRole, BookingStatus };

/**
 * AC-11 safeguard S3 — the minimum time a booking must have been `in_progress` before either party
 * may complete it. 60 seconds sits far below any real service duration
 * (`provider_services.duration_minutes` defaults to 60 *minutes*), so it blocks only the
 * start-then-immediately-complete shortcut, never a genuine short job.
 */
export const MIN_IN_PROGRESS_SECONDS = 60;

/**
 * AC-11 safeguard S4 — how long before `scheduled_at` the provider may first advance the booking.
 * A refusal to advance, never a signal that forces one (AC-7). Combined with S1 and S3, the
 * earliest a booking can reach `completed` is one hour before its scheduled time plus 60 seconds.
 */
export const EARLY_START_GRACE_MINUTES = 60;

/**
 * §3 "The complete transition matrix" — the SIX transitions spec 020 performs, and only those.
 * Kept in lockstep with the rows `0016_add_booking_creation_state_machine.sql` seeds: the database
 * trigger is the independent second line of defence (AC-6), this constant is the friendly error.
 *
 * Deliberately absent, each owned and seeded by its own spec: `pending -> failed`,
 * `completed -> protected`, `protected -> settled` (spec 021); `-> cancelled` (spec 023);
 * `-> disputed` (spec 031); `-> refunded` (spec 022). `completed` has NO outgoing transition here.
 */
export const SPEC_020_TRANSITIONS: ReadonlyArray<readonly [BookingStatus, BookingStatus]> = [
  ['pending', 'confirmed'],
  ['confirmed', 'provider_en_route'],
  ['confirmed', 'arrived'],
  ['provider_en_route', 'arrived'],
  ['arrived', 'in_progress'],
  ['in_progress', 'completed'],
] as const;

const ALLOWED = new Set(SPEC_020_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

/** True when `(from, to)` is one of the six transitions THIS spec performs. */
export function isAllowedBookingTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED.has(`${from}->${to}`);
}

/** The statuses a provider action can advance a booking out of, in lifecycle order. */
export const BOOKING_LIFECYCLE_ORDER: readonly BookingStatus[] = [
  'pending',
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
  'completed',
] as const;

export interface ApplyTransitionParams {
  bookingId: string;
  from: BookingStatus;
  to: BookingStatus;
  actorRole: BookingActorRole;
  /** null ONLY for `actorRole: 'system'` — `bookings_status_history_actor_pairing_ck` enforces it. */
  actorUserId: string | null;
  expectedVersion: number;
}

export interface ApplyTransitionResult {
  applied: boolean;
  currentStatus: BookingStatus;
  currentVersion: number;
}

/**
 * Applies one booking status transition inside the caller's transaction.
 *
 * The update is conditional on BOTH the expected status and the expected `version`, so a concurrent
 * writer is detected rather than silently overwritten — this is exactly what makes AC-9's
 * simultaneous customer/provider completion safe without any new column or mechanism. Of two
 * near-simultaneous valid completions only one matches the predicate; the loser gets
 * `applied: false` with the now-current status, and its caller returns `200` with the completed
 * booking rather than an error.
 *
 * Writes exactly one `bookings_status_history` row per successful transition, carrying
 * `actor_user_id` and `actor_role` (safeguard S6). The history table is append-only at the database
 * (`bookings_status_history_append_only_trg`), so attribution can never be rewritten.
 *
 * Returns rather than throws, so each caller can map "status mismatch" and "version mismatch" onto
 * the different HTTP codes §3 requires (`409 INVALID_STATUS_TRANSITION` vs `409 CONFLICT`).
 */
export async function applyBookingTransition(
  tx: Executor,
  params: ApplyTransitionParams,
): Promise<ApplyTransitionResult> {
  const { bookingId, from, to, actorRole, actorUserId, expectedVersion } = params;

  if (!isAllowedBookingTransition(from, to)) {
    // A spec-020 caller asking for a transition spec 020 does not own is a programming error, not a
    // user error: fail loudly here rather than letting the database trigger report it as a 500.
    throw new Error(`Spec 020 does not own the booking transition ${from} -> ${to}`);
  }
  if ((actorUserId === null) !== (actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }

  const updated = await queryRows<{ version: number }>(
    tx,
    sql`UPDATE bookings
           SET status = ${to}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${bookingId} AND status = ${from} AND version = ${expectedVersion}
         RETURNING version`,
  );

  if (updated.length === 0) {
    const current = await currentBookingState(tx, bookingId);
    return { applied: false, currentStatus: current.status, currentVersion: current.version };
  }

  await tx.execute(sql`
    INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
    VALUES (${bookingId}, ${from}, ${to}, ${actorUserId}, ${actorRole}, clock_timestamp())
  `);

  console.log(
    JSON.stringify({ event: 'booking.transition', bookingId, fromStatus: from, toStatus: to, actorRole }),
  );

  return { applied: true, currentStatus: to, currentVersion: updated[0]!.version };
}

/**
 * Records the creation of a booking in its initial `pending` state. Not a transition — there is no
 * `(null, 'pending')` row in `bookings_status_transitions` because the trigger only fires on UPDATE
 * — so it is written directly, with `from_status` null.
 */
export async function recordBookingCreated(
  tx: Executor,
  params: { bookingId: string; actorUserId: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
    VALUES (${params.bookingId}, NULL, 'pending', ${params.actorUserId}, 'customer', clock_timestamp())
  `);
}

/**
 * §3 "Why `pending` then `confirmed` in one transaction" — the confirmation step, exported
 * separately so **spec 021** can interpose its payment authorization between the insert and this
 * call (its AC-1/AC-6: "no booking is confirmed on a failed payment") without changing this spec's
 * transition graph, routes or DTO. This spec installs no gate, so creation calls it immediately and
 * `POST /bookings` returns a `confirmed` booking.
 */
export async function confirmBooking(
  tx: Executor,
  params: { bookingId: string; actorUserId: string; expectedVersion: number },
): Promise<ApplyTransitionResult> {
  return applyBookingTransition(tx, {
    bookingId: params.bookingId,
    from: 'pending',
    to: 'confirmed',
    actorRole: 'customer',
    actorUserId: params.actorUserId,
    expectedVersion: params.expectedVersion,
  });
}

export async function currentBookingState(
  tx: Executor,
  bookingId: string,
): Promise<{ status: BookingStatus; version: number }> {
  const [row] = await queryRows<{ status: BookingStatus; version: number }>(
    tx,
    sql`SELECT status, version FROM bookings WHERE id = ${bookingId}`,
  );
  if (!row) throw new Error(`booking ${bookingId} disappeared mid-transition`);
  return row;
}

/**
 * The spec 003 `enforce_status_transition()` trigger raises `SQLSTATE 23514` for a pair absent from
 * `bookings_status_transitions`. AC-6 requires that the database rejection and the application
 * rejection produce the same `409 INVALID_STATUS_TRANSITION`, so callers funnel driver errors
 * through this predicate rather than letting one surface as a 500.
 */
export function isTransitionCheckViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === '23514' && typeof candidate.message === 'string') {
      return candidate.message.includes('status transition');
    }
    current = candidate.cause;
  }
  return false;
}
