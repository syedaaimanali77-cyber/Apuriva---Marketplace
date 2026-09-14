import { and, eq, notInArray, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { bookings, customerProfiles, offers, providerProfiles, requests } from '@/lib/db/schema';
import type { BookingStatus } from '@/lib/types/bookings';

/**
 * Adapter isolating spec 008 AC-4's "does this user have an active booking" check from the booking
 * lifecycle/status contract. **Spec 020 has now shipped that contract**: `bookings.status` is no
 * longer spec 003's bare `text` column but the twelve-value vocabulary spec 020 §4 authors
 * (`BOOKING_STATUSES` in lib/db/schema.ts), with `bookings_status_ck` and the spec 003 transition
 * trigger enforcing it. Spec 028 layers execution-lifecycle detail on top; spec 021/022/023/031 add
 * transitions into `protected`/`settled`/`refunded`/`cancelled`/`disputed`.
 *
 * This module remains the ONLY place spec 008 encodes an opinion about which statuses count as
 * "resolved", exactly as its original note intended — and this is the single-file change that note
 * anticipated. The allowlist below was already correct against spec 020's vocabulary, so only its
 * TYPE changed: it is now `BookingStatus[]` rather than `string[]`, which means a future spec that
 * renames or removes a status breaks this file at compile time instead of silently letting a live
 * booking count as resolved. `lib/privacy/deletion.ts` calls `hasActiveBooking` and never encodes
 * booking-status knowledge itself.
 *
 * Spec 020 §4 "Retention and privacy": a booking row is NEVER deleted or anonymized by account
 * deletion — it is a financial/audit record — so this guard, which refuses deletion while any
 * booking is unresolved, is the whole of spec 008's interaction with bookings.
 */
const PROVISIONAL_RESOLVED_BOOKING_STATUSES: BookingStatus[] = [
  'completed',
  'settled',
  'cancelled',
  'refunded',
  'failed',
];

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
