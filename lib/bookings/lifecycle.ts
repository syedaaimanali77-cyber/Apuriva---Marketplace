/**
 * Spec 020 §3 "Lifecycle transitions" (AC-4, AC-6, AC-7, AC-11) — the provider's three actions.
 *
 * AC-7 in concrete terms: this module is the only thing that advances a booking through
 * arrival/start, and every one of its entry points requires an explicit, authenticated, authorized
 * provider `POST`. There is no cron, sweep, scheduler, webhook, GPS or geofence anywhere in
 * `lib/bookings/**` — a location or time signal has no interface through which to move the state
 * machine, and `actorRole: 'system'` is never passed by any spec 020 call site.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { BookingDto, BookingStatus } from '@/lib/types/bookings';
import {
  bookingNotStartableYetError,
  bookingVersionConflictError,
  invalidStatusTransitionError,
} from './errors';
import { loadBookingDto, requireBookingParticipant } from './read';
import { applyBookingTransition, EARLY_START_GRACE_MINUTES, isTransitionCheckViolation } from './state-machine';

/** The statuses each provider action may advance FROM, in the order the graph allows. */
const SOURCES: Record<ProviderAction, readonly BookingStatus[]> = {
  provider_en_route: ['confirmed'],
  // AC-4: the "on my way" step is OPTIONAL, so `arrived` is reachable from either.
  arrived: ['confirmed', 'provider_en_route'],
  in_progress: ['arrived'],
};

export type ProviderAction = 'provider_en_route' | 'arrived' | 'in_progress';

/**
 * AC-11 safeguard S4 — a booking cannot be advanced more than `EARLY_START_GRACE_MINUTES` before
 * its scheduled time. Read on the DATABASE clock in a statement issued after the row lock, never
 * `now()` (frozen at transaction start) and never a client clock.
 *
 * Only the first step out of `confirmed` is guarded: once a provider is legitimately en route or
 * arrived, the schedule has already been respected and re-checking would only add flakiness.
 */
async function assertStartable(tx: Parameters<typeof applyBookingTransition>[0], bookingId: string): Promise<void> {
  const [row] = await queryRows<{ too_early: boolean; startable_from: Date }>(
    tx,
    sql`SELECT clock_timestamp() < b.scheduled_at - make_interval(mins => ${EARLY_START_GRACE_MINUTES}) AS too_early,
               b.scheduled_at - make_interval(mins => ${EARLY_START_GRACE_MINUTES}) AS startable_from
          FROM bookings b WHERE b.id = ${bookingId}`,
  );
  if (row?.too_early) throw bookingNotStartableYetError(new Date(row.startable_from).toISOString());
}

/**
 * Performs one provider lifecycle action.
 *
 * Naturally idempotent (§3): repeating an action when the booking is already in the target status
 * returns the current booking rather than an error, so a double-tap is never a failure. That is
 * also why these routes need no `Idempotency-Key`.
 */
export async function advanceBooking(
  providerUserId: string,
  providerProfileId: string,
  bookingId: string,
  action: ProviderAction,
): Promise<BookingDto> {
  const { booking } = await requireBookingParticipant(providerUserId, bookingId, 'provider');
  if (booking.providerProfileId !== providerProfileId) {
    // The caller's own provider profile is not this booking's provider.
    const { bookingNotFoundError } = await import('./errors');
    throw bookingNotFoundError();
  }

  if (booking.status === action) return booking;

  const from = booking.status;
  if (!SOURCES[action].includes(from)) throw invalidStatusTransitionError(from);

  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`);

      // Re-read under the lock: the status may have moved between the check above and the lock.
      const [locked] = await queryRows<{ status: BookingStatus; version: number }>(
        tx,
        sql`SELECT status, version FROM bookings WHERE id = ${bookingId}`,
      );
      if (!locked) throw invalidStatusTransitionError(from);
      if (locked.status === action) return; // someone (the same provider, twice) already did it.
      if (!SOURCES[action].includes(locked.status)) throw invalidStatusTransitionError(locked.status);

      if (locked.status === 'confirmed') await assertStartable(tx, bookingId);

      const result = await applyBookingTransition(tx, {
        bookingId,
        from: locked.status,
        to: action,
        actorRole: 'provider',
        actorUserId: providerUserId,
        expectedVersion: locked.version,
      });
      if (!result.applied) {
        if (result.currentStatus === action) return;
        if (result.currentStatus !== locked.status) throw invalidStatusTransitionError(result.currentStatus);
        throw bookingVersionConflictError(result.currentVersion);
      }
    });
  } catch (err) {
    // AC-6: the spec 003 trigger is the independent second line of defence. Map its 23514 onto the
    // SAME `409 INVALID_STATUS_TRANSITION` the application check produces, never a 500.
    if (isTransitionCheckViolation(err)) throw invalidStatusTransitionError(from);
    throw err;
  }

  return loadBookingDto(bookingId);
}
