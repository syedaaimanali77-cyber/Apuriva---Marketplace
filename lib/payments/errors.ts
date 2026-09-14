/**
 * Spec 021 §3 "Error codes" — the codes new to this spec.
 *
 * None is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly —
 * the pattern spec 005's `MFA_REQUIRED`, spec 016's `SLOT_OVERLAP` and spec 020's
 * `BOOKING_NOT_FOUND` already follow. Codes owned by an earlier spec are RE-EXPORTED, never
 * redefined, so each keeps exactly one definition (spec 018's `lib/offers/errors.ts` idiom).
 */
import { ApiRouteError } from '@/lib/api/errors';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';

/**
 * `404` — no such booking/payment/adjustment, **or** the caller is not a participant. The two are
 * deliberately indistinguishable so ids cannot be probed (specs 015/018/019/020's rule). `403` is
 * reserved for a participant in the wrong active mode.
 */
export function paymentNotFoundError(): ApiRouteError {
  return new ApiRouteError('PAYMENT_NOT_FOUND', 'The requested payment does not exist.', { status: 404 });
}

/**
 * `422` AC-6 — the adapter declined or errored.
 *
 * The MESSAGE is master spec §105's exact payment wording, so the honest "no charge was confirmed"
 * statement is what the API says and not merely what the UI decorates. `failureCode` is the
 * adapter's stable machine code; a raw vendor payload is never echoed.
 */
export const PAYMENT_FAILED_MESSAGE = "Payment wasn't completed. No charge was confirmed.";

export function paymentFailedError(failureCode?: string): ApiRouteError {
  return new ApiRouteError('PAYMENT_FAILED', PAYMENT_FAILED_MESSAGE, {
    status: 422,
    details: { failureCode: failureCode ?? 'declined', retryable: true },
  });
}

/** `422` — a distinct provider outcome: 3DS or equivalent step-up is required before money moves. */
export function paymentRequiresActionError(actionKind?: string): ApiRouteError {
  return new ApiRouteError('PAYMENT_REQUIRES_ACTION', 'This payment needs an extra verification step before it can complete.', {
    status: 422,
    details: { providerActionKind: actionKind ?? 'unknown' },
  });
}

/** `422` — the booking is not `pending`, so there is no confirmation for a payment to gate. */
export function bookingNotAwaitingPaymentError(currentStatus: string): ApiRouteError {
  return new ApiRouteError('BOOKING_NOT_AWAITING_PAYMENT', `This booking is ${currentStatus.replace(/_/g, ' ')}, so it is not awaiting payment.`, {
    status: 422,
    details: { currentStatus },
  });
}

/**
 * `422` — capture attempted on a payment the provider has not authorized yet.
 *
 * Distinct from `PAYMENT_FAILED`, which means the provider actually refused: this one means no
 * provider call has succeeded yet, so claiming a failure would itself be a fabricated outcome.
 */
export function paymentNotAuthorizedError(currentStatus: string): ApiRouteError {
  return new ApiRouteError('PAYMENT_NOT_AUTHORIZED', 'This payment has not been authorized yet, so it cannot be captured.', {
    status: 422,
    details: { currentStatus },
  });
}

/** `409` — capture attempted on an already-captured payment under a DIFFERENT idempotency key. */
export function paymentAlreadyCapturedError(): ApiRouteError {
  return new ApiRouteError('PAYMENT_ALREADY_CAPTURED', 'This payment has already been captured.', { status: 409 });
}

/** `409` — stale `version` on a payment or adjustment (spec 003 AC-6 concurrency). */
export function paymentVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError('CONFLICT', `This payment was changed by someone else. Current version is ${currentVersion}; refetch and retry.`, {
    details: { currentVersion },
  });
}

/**
 * `422` AC-4 — an additional charge attempted with no `approved` adjustment on record.
 *
 * `422`, not the draft's `403`: this is a domain-rule violation, not a permission failure, and
 * `403` in this repository means "wrong active mode".
 */
export function adjustmentApprovalRequiredError(): ApiRouteError {
  return new ApiRouteError('ADJUSTMENT_APPROVAL_REQUIRED', 'This price change has not been approved by the customer, so it cannot be charged.', {
    status: 422,
  });
}

/** `409` — approve/reject on an adjustment that is no longer `pending_approval`. */
export function adjustmentAlreadyResolvedError(currentStatus: string): ApiRouteError {
  return new ApiRouteError('ADJUSTMENT_ALREADY_RESOLVED', `This price change is already ${currentStatus.replace(/_/g, ' ')}.`, {
    status: 409,
    details: { currentStatus },
  });
}

/** `422` — an adjustment must be in the booking's own currency (§3 "Price adjustments" rule 5). */
export function adjustmentCurrencyMismatchError(expected: string, received: string): ApiRouteError {
  return new ApiRouteError('ADJUSTMENT_CURRENCY_MISMATCH', `This booking is priced in ${expected}, so a price change must also be in ${expected}.`, {
    status: 422,
    details: { expectedCurrencyCode: expected, receivedCurrencyCode: received },
  });
}

/** `503` AC-10 — no usable adapter: the production sandbox guard, or an adapter outage. */
export function paymentProviderUnavailableError(): ApiRouteError {
  return new ApiRouteError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payments are temporarily unavailable. No charge was attempted.', {
    status: 503,
  });
}
