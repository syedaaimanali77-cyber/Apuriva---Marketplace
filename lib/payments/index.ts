/**
 * Spec 021 — the payment domain barrel, and the composition root for its two spec 020 seams.
 *
 * Importing this module:
 *   1. registers the three booking transitions spec 021 OWNS (`pending -> failed`,
 *      `completed -> protected`, `protected -> settled`), which spec 020 §3 "Payment boundary"
 *      reserved for this spec and `0017` seeds into `bookings_status_transitions`;
 *   2. registers the booking CONFIRMATION GATE, so a booking commits `pending` and is confirmed
 *      only once this domain has a provider-confirmed capture (AC-1/AC-6).
 *
 * The direction of every dependency is spec 021 → spec 020, never the reverse: `lib/bookings/**`
 * imports no payment module and reads no payment state, which is exactly what spec 020's
 * `payment-boundary.test.ts` asserts, unmodified.
 *
 * `instrumentation.ts` at the project root imports this module once per server instance, which is
 * what makes the gate live for `POST /api/v1/bookings` without that route — a spec 020 file —
 * importing anything of this spec's.
 */
import { registerBookingConfirmationGate, registerBookingTransitions } from '@/lib/bookings';

let registered = false;

/**
 * Idempotent. Called by this module's own import side effect and by `instrumentation.ts`; tests
 * call it too, because Vitest gives each test file its own module registry.
 */
export function registerPaymentIntegration(): void {
  if (registered) return;
  registered = true;

  registerBookingTransitions('spec 021 (payments)', [
    ['pending', 'failed'],
    ['completed', 'protected'],
    ['protected', 'settled'],
  ]);

  // Every booking in this repository is created from an accepted offer with a positive price
  // (`bookings.offer_id` is NOT NULL, and `bookings_price_positive_ck` guarantees the amount), so
  // every booking needs a payment before it may be confirmed. The gate therefore needs no per-row
  // query — and deliberately performs none, since it runs inside `createBooking`'s transaction
  // while the request, offer and provider-slot locks are held.
  registerBookingConfirmationGate(async () => ({ confirmNow: false }));
}

registerPaymentIntegration();

export { authorizePayment, capturePayment } from './authorize';
export {
  approvePriceAdjustment,
  chargeRemainder,
  proposePriceAdjustment,
  rejectPriceAdjustment,
} from './price-adjustment';
export { findPaymentByBookingId, listPriceAdjustments, loadPaymentDto, loadPriceAdjustmentDto } from './read';
export {
  DEFAULT_PROTECTION_WINDOW_HOURS,
  MAX_PROTECTION_WINDOW_HOURS,
  MIN_PROTECTION_WINDOW_HOURS,
  getDisputeGate,
  hasProtectionWindowElapsed,
  isValidProtectionWindowHours,
  nextProtectionState,
  protectionWindowEndsAt,
  registerDisputeGate,
  resetDisputeGate,
  resolveProtectionWindowHours,
  type DisputeGate,
} from './protection-window';
export {
  DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES,
  paymentAuthorizationWindowMinutes,
  runPaymentSweep,
  type PaymentSweepResult,
} from './sweep';
export {
  PAYMENT_STATUSES,
  SPEC_021_PAYMENT_TRANSITIONS,
  isAllowedPaymentTransition,
  isTerminalPaymentStatus,
} from './state-machine';
export { initialChargeAmountMinorUnits, resolvePaymentTiming, PRICING_MODELS, type PricingModel } from './timing';
export { PAYMENT_PROVIDER_ENV_VAR, PaymentProviderUnavailable, resolvePaymentProvider } from './provider';
export { PAYMENT_FAILED_MESSAGE } from './errors';
