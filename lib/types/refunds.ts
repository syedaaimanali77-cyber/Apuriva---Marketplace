/**
 * Spec 022 §3 "Request and response types" — the refund surface's public contract.
 *
 * Two rules shape everything here, both asserted by `lib/refunds/no-policy-leak.test.ts` and
 * `lib/payments/no-fabricated-success.test.ts`:
 *
 *   1. Nothing provider-facing or admin-internal crosses this boundary. `RefundDto` carries no
 *      `providerReference`, no `refundReference`, no failure code, no idempotency data and no
 *      initiating user id — those are reconciliation and security data, not the customer's
 *      (§4 "Retention and privacy"). `adminActionId` is present only on the admin surface.
 *   2. The customer-facing create request has NO amount field. A client-supplied refund amount
 *      would be a client deciding how much money to send itself; the amount comes from spec 023's
 *      eligibility decision, server-side, always.
 */

/** §3 "Refund lifecycle". `requested`/`processing` are in-flight; `completed`/`failed` terminal. */
export const REFUND_STATUSES = ['requested', 'processing', 'completed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** §3 "Reconciliation seam". Spec 022 only ever writes `pending`; `reconciled` is spec 024's. */
export const REFUND_RECONCILIATION_STATES = ['pending', 'reconciled'] as const;
export type RefundReconciliationState = (typeof REFUND_RECONCILIATION_STATES)[number];

export const REFUND_SOURCES = ['policy', 'admin_override'] as const;
export type RefundSource = (typeof REFUND_SOURCES)[number];

/** Who caused a refund transition. `system` is the sweep; `null` actor pairs with it. */
export const REFUND_ACTOR_ROLES = ['customer', 'provider', 'admin', 'system'] as const;
export type RefundActorRole = (typeof REFUND_ACTOR_ROLES)[number];

export function isRefundStatus(value: unknown): value is RefundStatus {
  return typeof value === 'string' && (REFUND_STATUSES as readonly string[]).includes(value);
}

export function isRefundReconciliationState(value: unknown): value is RefundReconciliationState {
  return typeof value === 'string' && (REFUND_RECONCILIATION_STATES as readonly string[]).includes(value);
}

export interface RefundLineDto {
  id: string;
  lineAmountMinorUnits: number;
  lineCurrencyCode: string;
  reason: string;
}

export interface RefundDto {
  id: string;
  bookingId: string;
  paymentId: string;
  status: RefundStatus;
  totalAmountMinorUnits: number;
  totalCurrencyCode: string;
  lines: RefundLineDto[];
  source: RefundSource;
  isOverride: boolean;
  /** Present ONLY on the admin surface — never on a participant response. */
  adminActionId?: string;
  reconciliationState: RefundReconciliationState;
  completedAt: string | null;
  createdAt: string;
  version: number;
}

/**
 * `202` body for an override awaiting a second admin (AC-3). No refund row exists yet, and no
 * provider call has been made — which is the whole point of returning this instead of a `RefundDto`.
 */
export interface RefundOverrideDto {
  adminActionId: string;
  status: 'pending_approval';
  bookingId: string;
  amountMinorUnits: number;
  currencyCode: string;
}

/** `POST /bookings/{id}/refunds` — deliberately has NO amount field. */
export interface CreateRefundRequest {
  /** Optional free-text the customer supplies. Never becomes the recorded line reason. */
  note?: string;
}

export interface CreateAdminRefundRequest {
  bookingId: string;
  amountMinorUnits: number;
  currencyCode: string;
  reason: string;
}

/**
 * §3 "Financial invariants" — the refundable position of one payment, as reported to callers.
 * Derived under the payment row lock; never cached.
 */
export interface RefundablePosition {
  capturedAmountMinorUnits: number;
  completedRefundedMinorUnits: number;
  inFlightRefundedMinorUnits: number;
  remainingRefundableMinorUnits: number;
  currencyCode: string;
}
