/**
 * Spec 020 §4 "Busy-interval loader (the spec 016 contract)".
 *
 * Spec 016 ships `reserveProviderSlot()` fully implemented but parameterized over a
 * `BusyIntervalLoader` port, because `bookings` is spec 020's table and spec 016 must not read it
 * (spec 003 AC-4). Until now the registered default returned `[]` — correct rather than a stub,
 * since no booking could carry a scheduled time. This module supplies the real loader, and
 * registering it is what makes spec 016's double-booking prevention (its AC-2) and its
 * strand-a-booking schedule guard (its §8 risk #6) live against real data.
 *
 * THE OCCUPYING SET is spec 020's to define (spec 016 §3 "What spec 020 must do", point 2), and it
 * is defined as *every status that has not released the slot*:
 *
 *   releases the slot : cancelled, refunded, failed
 *   occupies the slot : pending, confirmed, provider_en_route, arrived, in_progress,
 *                       completed, protected, settled, disputed
 *
 * `pending` occupies because a booking awaiting spec 021's confirmation gate must still hold its
 * time — otherwise a payment authorization in flight could have its slot sold underneath it.
 * `completed`/`protected`/`settled` occupy so that historical time is never re-sold. Note that
 * naming `protected`/`settled` here is a READ of the vocabulary this spec owns, not a transition
 * into them: nothing in this file writes `bookings.status` (§3 "Payment boundary").
 */
import { sql } from 'drizzle-orm';
import { registerBusyIntervalLoader, type BusyInterval, type BusyIntervalLoader, type Tx } from '@/lib/availability/busy-intervals';
import { queryRows } from '@/lib/offers/db';
import type { BookingStatus } from '@/lib/types/bookings';

/** Statuses whose booking still occupies its provider's time. */
export const SLOT_OCCUPYING_BOOKING_STATUSES: readonly BookingStatus[] = [
  'pending',
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
  'completed',
  'protected',
  'settled',
  'disputed',
] as const;

/** Statuses whose booking has released its provider's time. */
export const SLOT_RELEASING_BOOKING_STATUSES: readonly BookingStatus[] = ['cancelled', 'refunded', 'failed'] as const;

interface BusyRow {
  start_at: Date;
  end_at: Date;
  service_id: string;
  source_id: string;
}

/**
 * Every occupying booking for `providerProfileId` overlapping `range`, as half-open
 * `[startAt, endAt)` intervals (spec 016 R7). `sourceId` is the booking id — opaque to spec 016 and
 * echoed only into its OWNER-ONLY `SLOT_OVERLAP` message; spec 020 never forwards that message to a
 * customer (§3 step 13).
 *
 * Runs on whatever handle the caller is already inside, so the read happens under the provider row
 * lock `reserveProviderSlot` has already taken — which is precisely what makes the check race-free.
 */
export const loadBookingBusyIntervals: BusyIntervalLoader = async (
  tx: Tx,
  providerProfileId: string,
  range: { from: Date; to: Date },
): Promise<BusyInterval[]> => {
  const rows = await queryRows<BusyRow>(
    tx,
    sql`SELECT b.scheduled_at                                             AS start_at,
               b.scheduled_at + make_interval(mins => b.duration_minutes) AS end_at,
               b.service_id,
               b.id                                                       AS source_id
          FROM bookings b
         WHERE b.provider_profile_id = ${providerProfileId}
           AND b.status IN (${sql.join(SLOT_OCCUPYING_BOOKING_STATUSES.map((status) => sql`${status}`), sql`, `)})
           AND b.scheduled_at < ${range.to.toISOString()}::timestamptz
           AND b.scheduled_at + make_interval(mins => b.duration_minutes) > ${range.from.toISOString()}::timestamptz`,
  );

  return rows.map((row) => ({
    startAt: new Date(row.start_at),
    endAt: new Date(row.end_at),
    serviceId: row.service_id,
    sourceId: row.source_id,
  }));
};

let registered = false;

/**
 * Registers the real loader with spec 016. Idempotent, so importing the `lib/bookings` barrel from
 * several modules (or from a test) cannot double-register. Called from `lib/bookings/index.ts`,
 * which every booking route and every booking test imports.
 */
export function registerBookingBusyIntervals(): void {
  if (registered) return;
  registerBusyIntervalLoader(loadBookingBusyIntervals);
  registered = true;
}

/** Test-only: lets a suite re-register after `resetBusyIntervalLoader()` restored the default. */
export function resetBookingBusyIntervalsRegistration(): void {
  registered = false;
}
