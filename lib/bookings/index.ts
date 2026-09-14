/**
 * Spec 020 — the booking domain barrel.
 *
 * Importing this module registers the real `BusyIntervalLoader` with spec 016, which is what makes
 * `reserveProviderSlot()` and spec 016's strand-a-booking schedule guard live against real bookings
 * (spec 016 §3 "Interface with spec 020"). Every booking route and every booking test imports from
 * here, so the port is always live wherever a booking can be created.
 *
 * MCP (§3 "MCP implications"): every guarantee this spec makes — authorization, revalidation,
 * idempotency, the dwell and early-start guards, the evidence gate, the transition primitive —
 * lives in these domain functions, never in a route handler. Spec 036's `create_booking`,
 * `mark_provider_arrived`, `start_service` and `complete_service` tools call them and inherit the
 * guarantees rather than reimplementing them, exactly as spec 019 §7 requires of its own tools.
 */
import { registerBookingBusyIntervals } from './busy-intervals';

registerBookingBusyIntervals();

export { createBooking, type CreateBookingResult } from './create';
export { advanceBooking, type ProviderAction } from './lifecycle';
export { completeBooking } from './complete';
export {
  BOOKING_LIST_FILTERS,
  isBookingListFilter,
  listBookings,
  loadBookingDto,
  loadBookingStatusHistory,
  requireBookingParticipant,
  type BookingParticipation,
} from './read';
export {
  applyBookingTransition,
  confirmBooking,
  isAllowedBookingTransition,
  BOOKING_STATUSES,
  EARLY_START_GRACE_MINUTES,
  MIN_IN_PROGRESS_SECONDS,
  SPEC_020_TRANSITIONS,
} from './state-machine';
export {
  getCompletionEvidenceGate,
  registerCompletionEvidenceGate,
  resetCompletionEvidenceGate,
  type CompletionEvidenceGate,
  type CompletionEvidenceStatus,
} from './completion-evidence';
export {
  loadBookingBusyIntervals,
  registerBookingBusyIntervals,
  SLOT_OCCUPYING_BOOKING_STATUSES,
  SLOT_RELEASING_BOOKING_STATUSES,
} from './busy-intervals';
export { ALTERNATIVE_LOOKAHEAD_DAYS, MAX_ALTERNATIVES, buildSlotUnavailableDetails } from './alternatives';
