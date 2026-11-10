/**
 * Spec 021 §3 "Request and response types" — the payment surface's public contract.
 *
 * Two rules shape everything here and are asserted by `lib/payments/no-fabricated-success.test.ts`:
 *
 *   1. Nothing provider-facing crosses this boundary. `PaymentDto` carries no `providerReference`,
 *      no provider name, no attempt list and no failure code — those are internal reconciliation
 *      handles, not the customer's data (§4 "Retention and privacy").
 *   2. Every field is a projection of a persisted column. There is no derived "looks successful"
 *      state, because master spec §132.7 forbids reporting a payment outcome the backend did not
 *      confirm. The single exception, `protectionWindowEndsAt`, is pure arithmetic over two stored
 *      columns and is null whenever they are.
 */

/**
 * The WHOLE `payments.status` vocabulary, authored once here the way spec 020 authored the booking
 * vocabulary. `refunded`/`partially_refunded` are named here but their TRANSITIONS are seeded by
 * spec 022 in its own migration — this spec seeds only the transitions it performs.
 */
export const PAYMENT_STATUSES = [
  'created',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** §3 "Protection window" — null until the window opens on booking completion. */
export const PAYMENT_PROTECTION_STATES = ['held', 'released', 'disputed'] as const;
export type PaymentProtectionState = (typeof PAYMENT_PROTECTION_STATES)[number];

export const PRICE_ADJUSTMENT_STATUSES = ['pending_approval', 'approved', 'rejected', 'charged', 'failed'] as const;
export type PriceAdjustmentStatus = (typeof PRICE_ADJUSTMENT_STATUSES)[number];

/** The outcomes a provider adapter may report. Never widened by application code. */
export const PAYMENT_ATTEMPT_STATUSES = ['succeeded', 'failed', 'requires_action'] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function isPaymentProtectionState(value: unknown): value is PaymentProtectionState {
  return typeof value === 'string' && (PAYMENT_PROTECTION_STATES as readonly string[]).includes(value);
}

export function isPriceAdjustmentStatus(value: unknown): value is PriceAdjustmentStatus {
  return typeof value === 'string' && (PRICE_ADJUSTMENT_STATUSES as readonly string[]).includes(value);
}

export interface PaymentDto {
  id: string;
  bookingId: string;
  status: PaymentStatus;
  chargeAmountMinorUnits: number;
  chargeCurrencyCode: string;
  /** null until the protection window opens (the booking reaching `completed`). */
  protectionState: PaymentProtectionState | null;
  protectionWindowStartedAt: string | null;
  protectionWindowHours: number;
  /** Derived from the two fields above, never stored; null until the window opens. */
  protectionWindowEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PriceAdjustmentDto {
  id: string;
  bookingId: string;
  additionalAmountMinorUnits: number;
  additionalCurrencyCode: string;
  reason: string;
  status: PriceAdjustmentStatus;
  approvedAt: string | null;
  createdAt: string;
  version: number;
}

/**
 * §3 "Payment timing" — the resolver's outcomes.
 *
 * `at_booking_confirmation` is the only outcome reachable in this repository today: every booking
 * is created from an accepted offer whose price is copied verbatim (spec 020 §3 step 14), so for a
 * fixed/scheduled service and for an offer-based service this is the same instant.
 *
 * `deposit_then_remainder` is typed and tested but unreachable, because no deposit column exists
 * anywhere in `lib/db/schema.ts`. Master spec §133.5 forbids inventing the data to make it
 * reachable — this is the ship-the-gate-not-the-requirement idiom spec 020 used for its
 * completion-evidence gate.
 */
export type PaymentTiming =
  | { kind: 'at_booking_confirmation' }
  | { kind: 'deposit_then_remainder'; depositAmountMinorUnits: number };
