/**
 * Spec 022 — the refund domain barrel, and the composition root for the payment transitions this
 * spec owns.
 *
 * Importing this module registers `captured -> refunded`, `captured -> partially_refunded` and
 * `partially_refunded -> refunded` — the three transitions spec 021 §4 reserved for spec 022 and
 * migration `0018` seeds. Spec 021's own graph is untouched: `SPEC_021_PAYMENT_TRANSITIONS` and
 * `isAllowedPaymentTransition()` still answer only for spec 021, so its tests pass unchanged.
 *
 * Booking transitions into `refunded` need no registration here: `applyBookingTransition` is
 * reached through the same `registerBookingTransitions` extension spec 021 already installs, and
 * `registerRefundIntegration()` adds this spec's own booking pair on top.
 *
 * The dependency direction is strictly spec 022 → specs 009/020/021, never the reverse. The three
 * ports this spec ships (`RefundEligibilityGate`, `RefundReconciliationSink`,
 * `RefundNotificationSink`) are registered by specs 023, 024 and 026 when they arrive.
 */
import { registerBookingTransitions } from '@/lib/bookings';
import { registerPaymentTransitions } from '@/lib/payments/state-machine';

let registered = false;

/**
 * Idempotent. Called by this module's own import side effect and by `instrumentation.ts`; tests
 * call it too, because Vitest gives each test file its own module registry.
 */
export function registerRefundIntegration(): void {
  if (registered) return;
  registered = true;

  registerPaymentTransitions('spec 022 (refunds)', [
    ['captured', 'refunded'],
    ['captured', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
  ]);

  // Spec 020 §4 reserved every booking transition into `refunded` for this spec. Only a FULLY
  // completed refund performs one.
  registerBookingTransitions('spec 022 (refunds)', [
    ['completed', 'refunded'],
    ['protected', 'refunded'],
    ['settled', 'refunded'],
    ['cancelled', 'refunded'],
  ]);
}

registerRefundIntegration();
export {
  fitsWithinRemaining,
  isFullyRefunded,
  isPaymentFullyRefunded,
  isValidCurrencyCode,
  isValidRefundAmount,
  linesShareCurrency,
  linesSumTo,
  readRefundablePosition,
  type RefundLineInput,
  type RefundablePosition,
} from './amounts';
export {
  getRefundEligibilityGate,
  invalidEligibilityField,
  registerRefundEligibilityGate,
  resetRefundEligibilityGate,
  type RefundEligibility,
  type RefundEligibilityGate,
} from './eligibility';
export { executeApprovedRefund, executeReservedRefund, recordRefundOutcome, requestPolicyRefund } from './execute';
export {
  REFUND_OVERRIDE_ACTION,
  REFUND_OVERRIDE_RESOURCE,
  REFUND_READ_ACTION,
  executeRefundOverride,
  initiateRefundOverride,
  requireRefundReadPermission,
  type InitiateRefundOverrideResult,
} from './override';
export {
  emitRefundNotification,
  getRefundNotificationSink,
  registerRefundNotificationSink,
  resetRefundNotificationSink,
  type RefundNotificationEvent,
  type RefundNotificationSink,
} from './notifications';
export {
  emitRefundReconciliation,
  getRefundReconciliationSink,
  registerRefundReconciliationSink,
  resetRefundReconciliationSink,
  type RefundReconciliationEvent,
  type RefundReconciliationSink,
} from './reconciliation';
export {
  listRefundsForAdmin,
  listRefundsForBooking,
  listRefundsForBookingUnchecked,
  loadRefundDto,
  loadRefundStatusHistory,
  type AdminRefundFilters,
} from './read';
export {
  IN_FLIGHT_REFUND_STATUSES,
  REFUND_STATUSES,
  SPEC_022_REFUND_TRANSITIONS,
  TERMINAL_REFUND_STATUSES,
  isAllowedRefundTransition,
  isInFlightRefundStatus,
  isTerminalRefundStatus,
} from './state-machine';
export {
  DEFAULT_REFUND_AMBIGUITY_ESCALATION_MINUTES,
  refundAmbiguityEscalationMinutes,
  runRefundReconcileSweep,
  type RefundSweepResult,
} from './sweep';
