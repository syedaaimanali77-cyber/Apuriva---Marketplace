import { and, eq, notInArray, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { bookings, customerProfiles, offers, providerProfiles, requests } from '@/lib/db/schema';

/**
 * Adapter isolating spec 008 AC-4's "does this user have an active booking" check from spec 028's
 * (and spec 020's) booking lifecycle/status contract — neither is implemented yet: spec 020
 * ("Booking Creation & State Machine") declares the real status enum (`pending`, `confirmed`,
 * `provider_en_route`, `arrived`, `in_progress`, `completed`, `protected`, `settled`, `cancelled`,
 * `disputed`, `refunded`, `failed`) and owns the actual transition rules; spec 028 layers
 * execution-lifecycle detail on top of it. `bookings.status` is still spec 003's bare `text`
 * column — no real status machine exists anywhere in the implemented code yet.
 *
 * This module is the ONLY place spec 008 encodes an opinion about which statuses count as
 * "resolved" — a deliberately small, provisional allowlist, not a permanent booking lifecycle
 * model. When spec 020/028 ship their real status machine, only this file needs to change;
 * lib/privacy/deletion.ts calls `hasActiveBooking` and never encodes booking-status knowledge
 * itself.
 */
const PROVISIONAL_RESOLVED_BOOKING_STATUSES = ['completed', 'settled', 'cancelled', 'refunded', 'failed'];

/** True if `userId` (as customer or provider) has any booking not in the provisional
 * resolved-status allowlist above — i.e. still active enough to block deletion (AC-4). */
export async function hasActiveBooking(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(offers, eq(offers.id, bookings.offerId))
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, offers.providerProfileId))
    .where(
      and(
        or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)),
        notInArray(bookings.status, PROVISIONAL_RESOLVED_BOOKING_STATUSES),
      ),
    )
    .limit(1);
  return Boolean(row);
}
