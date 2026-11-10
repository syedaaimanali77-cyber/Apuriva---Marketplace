/**
 * Spec 020 §5 — shared client helpers for the three booking screens.
 *
 * Reuses spec 015's `apiFetch`/`mutateHeaders` (the CSRF-cookie-echo + `ApiResponse` unwrapping
 * pattern) rather than restating it; what lives here is only what is specific to bookings: the
 * poll cadence, the status vocabulary's display labels, and the dwell countdown arithmetic.
 */
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDateTime } from '@/lib/i18n/format';
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

/** Spec 042 X-12: the same status copy as dictionary keys, for the customer screens' `t()`. */
export const BOOKING_STATUS_KEYS: Record<BookingStatus, MessageKey> = {
  pending: 'bookings.status.pending',
  confirmed: 'bookings.status.confirmed',
  provider_en_route: 'bookings.status.provider_en_route',
  arrived: 'bookings.status.arrived',
  in_progress: 'bookings.status.in_progress',
  completed: 'bookings.status.completed',
  protected: 'bookings.status.protected',
  settled: 'bookings.status.settled',
  cancelled: 'bookings.status.cancelled',
  disputed: 'bookings.status.disputed',
  refunded: 'bookings.status.refunded',
  failed: 'bookings.status.failed',
};

/** Customer-facing copy for each status, in English (the English-only provider screens). Never a bare colour — §5 accessibility. */
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
export const BOOKING_PROGRESSION: { status: BookingStatus; label: string; labelKey: MessageKey }[] = [
  { status: 'confirmed', label: 'Booking confirmed', labelKey: 'bookings.progression.confirmed' },
  { status: 'provider_en_route', label: 'Provider on the way', labelKey: 'bookings.progression.provider_en_route' },
  { status: 'arrived', label: 'Provider arrived', labelKey: 'bookings.progression.arrived' },
  { status: 'in_progress', label: 'Service in progress', labelKey: 'bookings.progression.in_progress' },
  { status: 'completed', label: 'Completed', labelKey: 'bookings.progression.completed' },
];

export function progressionIndex(status: BookingStatus): number {
  const index = BOOKING_PROGRESSION.findIndex((step) => step.status === status);
  // `pending` sits before the first step; a terminal payment/dispute status sits at the last one.
  if (index >= 0) return index;
  return status === 'pending' ? 0 : BOOKING_PROGRESSION.length - 1;
}

/**
 * Formats an instant in the booking's own scheduling timezone, so both parties read one time. Spec 042
 * X-11: the shared formatter, in the reader's `locale` (the English-only provider screens pass none).
 */
export function formatScheduled(isoInstant: string, timeZone: string, locale = 'en'): string {
  try {
    return formatDateTime(isoInstant, locale, { dateStyle: 'full', timeStyle: 'short', timeZone });
  } catch {
    return new Date(isoInstant).toISOString();
  }
}

/** Formats one AC-2 alternative for the conflict screen. */
export function formatAlternative(alternative: { startAt: string; scheduledTimezone: string }, locale = 'en'): string {
  return formatScheduled(alternative.startAt, alternative.scheduledTimezone, locale);
}

/** Narrows an error body's `details` to AC-2's published shape, or null. */
export function slotConflictDetails(error: { code?: string; details?: unknown } | undefined): SlotUnavailableDetails | null {
  if (error?.code !== 'SLOT_NO_LONGER_AVAILABLE') return null;
  const details = error.details as SlotUnavailableDetails | undefined;
  return details && Array.isArray(details.alternatives) ? details : null;
}
