/**
 * Spec 028 §3 — the window during which a job is actually being executed.
 *
 * Named once, in its own module, because two separate rules depend on it being the same window:
 * a provider may post a milestone (AC-3) and may attach completion evidence (AC-7) exactly while
 * the job is happening — not before arrival, and not after the fact. Defining it twice would let
 * the two drift apart silently.
 *
 * This is a read-only predicate over spec 020's vocabulary. It grants nothing and transitions
 * nothing; spec 020 remains the sole owner of what the statuses are and how they change.
 */
import type { BookingStatus } from '@/lib/types/bookings';

export const EXECUTING_BOOKING_STATUSES: readonly BookingStatus[] = ['arrived', 'in_progress'];

export function isExecutingStatus(status: BookingStatus): boolean {
  return EXECUTING_BOOKING_STATUSES.includes(status);
}
