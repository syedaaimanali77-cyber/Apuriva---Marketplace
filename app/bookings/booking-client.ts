/**
 * Spec 020 §5 — shared client helpers for the three booking screens.
 *
 * Reuses spec 015's `apiFetch`/`mutateHeaders` (the CSRF-cookie-echo + `ApiResponse` unwrapping
 * pattern) rather than restating it; what lives here is only what is specific to bookings: the
 * poll cadence, the status vocabulary's display labels, and the dwell countdown arithmetic.
 */
import type { BookingStatus, SlotUnavailableDetails } from '@/lib/types/bookings';

export { apiFetch, mutateHeaders, type ApiErrorBody, type ApiResult } from '@/app/requests/api-client';

/**
 * §5 "Live updates: polling, not WebSocket". No WebSocket layer exists in this repository — specs
 * 018 and 019 both say so — so an open booking screen refetches on spec 018's cadence and on focus,
 * and stops once the booking reaches a status this spec cannot leave.
 */
export const BOOKING_POLL_MS = 10_000;

/** Statuses spec 020 can still move a booking out of. Polling stops at everything else. */
const LIVE_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed', 'provider_en_route', 'arrived', 'in_progress'];

export function isLiveBookingStatus(status: BookingStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/** Customer-facing copy for each status. Never a bare colour — §5 accessibility. */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Pending confirmation',
  confirmed: 'Confirmed',
  provider_en_route: 'Provider on the way',
  arrived: 'Provider arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  protected: 'Payment protected',
  settled: 'Settled',
  cancelled: 'Cancelled',
  disputed: 'In dispute',
  refunded: 'Refunded',
  failed: 'Not confirmed',
};

/** The timeline steps a booking moves through, in the order spec 020 seeds them. */
export const BOOKING_PROGRESSION: { status: BookingStatus; label: string }[] = [
  { status: 'confirmed', label: 'Booking confirmed' },
  { status: 'provider_en_route', label: 'Provider on the way' },
  { status: 'arrived', label: 'Provider arrived' },
  { status: 'in_progress', label: 'Service in progress' },
  { status: 'completed', label: 'Completed' },
];

export function progressionIndex(status: BookingStatus): number {
  const index = BOOKING_PROGRESSION.findIndex((step) => step.status === status);
  // `pending` sits before the first step; a terminal payment/dispute status sits at the last one.
  if (index >= 0) return index;
  return status === 'pending' ? 0 : BOOKING_PROGRESSION.length - 1;
}

/** Formats an instant in the booking's own scheduling timezone, so both parties read one time. */
export function formatScheduled(isoInstant: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(isoInstant));
  } catch {
    return new Date(isoInstant).toISOString();
  }
}

/** Formats one AC-2 alternative for the conflict screen. */
export function formatAlternative(alternative: { startAt: string; scheduledTimezone: string }): string {
  return formatScheduled(alternative.startAt, alternative.scheduledTimezone);
}

/** Narrows an error body's `details` to AC-2's published shape, or null. */
export function slotConflictDetails(error: { code?: string; details?: unknown } | undefined): SlotUnavailableDetails | null {
  if (error?.code !== 'SLOT_NO_LONGER_AVAILABLE') return null;
  const details = error.details as SlotUnavailableDetails | undefined;
  return details && Array.isArray(details.alternatives) ? details : null;
}
