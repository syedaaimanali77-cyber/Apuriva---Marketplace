/**
 * Spec 023 — the cancellation domain barrel, and the composition root for its two cross-spec seams.
 *
 * Importing this module:
 *   1. registers the three `→ cancelled` booking transitions spec 020 §3 reserved for this spec
 *      ("`-> cancelled` (spec 023)") and `0019` seeds into `bookings_status_transitions`;
 *   2. registers this spec's implementation of spec 022's `RefundEligibilityGate`, replacing that
 *      spec's inert `{ eligible: false }` default with the real policy decision.
 *
 * The direction of every dependency is spec 023 → specs 009/012/016/020/021/022, never the reverse.
 * `lib/bookings/**` still imports nothing of this spec's, and `lib/refunds/**` still contains no
 * cancellation rule — its `no-policy-leak.test.ts` guard passes unchanged, because the policy lives
 * here and reaches that spec only through the port it published.
 *
 * `instrumentation.ts` imports this once per server instance, the same way it imports spec 021's and
 * spec 022's barrels, so the seams are live for routes that never import this module directly.
 */
import { registerBookingTransitions } from '@/lib/bookings';
import { registerRefundEligibilityGate } from '@/lib/refunds/eligibility';
import { cancellationRefundEligibility } from './refund-eligibility';

let registered = false;

/**
 * Idempotent. Called by this module's own import side effect and by `instrumentation.ts`; tests call
 * it too, because Vitest gives each test file its own module registry.
 */
export function registerCancellationIntegration(): void {
  if (registered) return;
  registered = true;

  registerBookingTransitions('spec 023 (cancellation)', [
    ['confirmed', 'cancelled'],
    ['provider_en_route', 'cancelled'],
    ['arrived', 'cancelled'],
  ]);

  registerRefundEligibilityGate(cancellationRefundEligibility);
}

registerCancellationIntegration();

export {
  CANCELLABLE_BOOKING_STATUSES,
  cancelBooking,
  cancelBookingAsParticipant,
  isCancellableBookingStatus,
  previewCancellation,
  readCancellation,
  type CancelBookingInput,
} from './cancel';
export {
  CANCELLATION_POLICY_CONFIGURE_ACTION,
  CANCELLATION_POLICY_READ_ACTION,
  CANCELLATION_POLICY_RESOURCE,
  listCancellationPolicies,
  publishCancellationPolicy,
  requireCancellationPolicyConfigurePermission,
  requireCancellationPolicyReadPermission,
} from './admin';
export {
  emitCancellationNotification,
  getCancellationNotificationSink,
  registerCancellationNotificationSink,
  resetCancellationNotificationSink,
  type CancellationNotificationEvent,
  type CancellationNotificationSink,
} from './notifications';
export {
  PLATFORM_DEFAULT_CANCELLATION_CONFIG,
  parseCancellationPolicyConfig,
  validateCancellationPolicyConfig,
} from './policy-config';
export {
  ensurePolicyAcceptance,
  readAcceptance,
  readServiceCancellationPolicy,
  resolveEffectivePolicy,
  type ResolvedPolicy,
} from './resolution';
export { cancellationRefundEligibility, cancellationRefundReason } from './refund-eligibility';
export {
  computeCancellationConsequence,
  feeForTier,
  selectTier,
  toHoursBeforeMilli,
  type ConsequenceResult,
} from './tiers';
export { readBookingCancellationPolicy, setProviderCancellationOption } from './booking-policy';
