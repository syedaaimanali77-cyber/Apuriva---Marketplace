/**
 * Spec 025 §3 "Conversation lifecycle" and "Contact-sharing protection" — PURE derivations from
 * `bookings.status`. Neither is ever stored as an independent truth.
 */
import type { BookingStatus } from '@/lib/types/bookings';
import { ARCHIVED_BOOKING_STATUSES, PRE_CONFIRMATION_BOOKING_STATUSES } from './limits';

/** Read-only once money is final and no service relationship remains. */
export function isArchivedBookingStatus(status: BookingStatus): boolean {
  return ARCHIVED_BOOKING_STATUSES.includes(status);
}

/** Master spec §54 "after booking": the booking has reached `confirmed` (spec 021: payment authorized). */
export function isContactSharingAllowed(status: BookingStatus): boolean {
  return !PRE_CONFIRMATION_BOOKING_STATUSES.includes(status);
}
