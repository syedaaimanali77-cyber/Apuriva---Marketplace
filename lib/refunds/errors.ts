/**
 * Spec 022 §3 "Error codes" — the codes new to this spec.
 *
 * None is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly —
 * the pattern specs 005/016/020/021 already follow. Codes owned by an earlier spec are
 * RE-EXPORTED, never redefined, so each keeps exactly one definition.
 */
import { ApiRouteError } from '@/lib/api/errors';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { paymentProviderUnavailableError } from '@/lib/payments/errors';
export {
  approvalNotEligibleError,
  approvalRequiredError,
  selfApprovalNotAllowedError,
  adminForbiddenError,
} from '@/lib/admin-rbac/errors';

/**
 * `404` — no such booking/refund, **or** the caller is not a participant. The two are deliberately
 * indistinguishable so ids cannot be probed (specs 015/018/019/020/021's rule). `403` is reserved
 * for a participant in the wrong active mode and for an admin lacking the permission.
 */
export function refundNotFoundError(): ApiRouteError {
  return new ApiRouteError('REFUND_NOT_FOUND', 'The requested refund does not exist.', { status: 404 });
}

/** `422` — the booking's payment was never captured, so there is nothing to refund. */
export function paymentNotCapturedError(): ApiRouteError {
  return new ApiRouteError('PAYMENT_NOT_CAPTURED', 'This booking has no captured payment, so there is nothing to refund.', {
    status: 422,
  });
}

/** `422` — the booking is in a status from which no refund is possible. */
export function bookingNotRefundableError(currentStatus: string): ApiRouteError {
  return new ApiRouteError('BOOKING_NOT_REFUNDABLE', `This booking is ${currentStatus.replace(/_/g, ' ')}, so it cannot be refunded.`, {
    status: 422,
    details: { currentStatus },
  });
}

/**
 * `422` — the eligibility gate declined, or could not be consulted.
 *
 * `details.reason` distinguishes "policy says no" from "no policy is available", because the two
 * mean very different things operationally — but neither is ever a default-allow.
 */
export function refundNotEligibleError(reason: 'not_eligible' | 'eligibility_unavailable' = 'not_eligible'): ApiRouteError {
  return new ApiRouteError(
    'REFUND_NOT_ELIGIBLE',
    reason === 'eligibility_unavailable'
      ? 'Refund eligibility cannot be determined right now, so no refund was issued.'
      : 'This booking is not eligible for an automatic refund.',
    { status: 422, details: { reason } },
  );
}

/**
 * `422` — the gate returned `eligible: true` with a missing or malformed amount, currency or
 * reason. A half-specified decision is a defect in the supplying spec, never a reason to guess.
 */
export function refundEligibilityInvalidError(field: string): ApiRouteError {
  return new ApiRouteError('REFUND_ELIGIBILITY_INVALID', 'The refund eligibility decision was incomplete, so no refund was issued.', {
    status: 422,
    details: { field },
  });
}

/** `422` — non-integer, zero or negative amount, or lines that do not sum to the total (I-3/I-5). */
export function refundAmountInvalidError(detail: string): ApiRouteError {
  return new ApiRouteError('REFUND_AMOUNT_INVALID', 'That refund amount is not valid.', {
    status: 422,
    details: { detail },
  });
}

/** `422` — the refund currency differs from the booking's (I-6). */
export function refundCurrencyMismatchError(expected: string, received: string): ApiRouteError {
  return new ApiRouteError('REFUND_CURRENCY_MISMATCH', `This booking is priced in ${expected}, so a refund must also be in ${expected}.`, {
    status: 422,
    details: { expectedCurrencyCode: expected, receivedCurrencyCode: received },
  });
}

/**
 * `422` AC-5 — the request exceeds what remains refundable. Carries the remaining amount so a
 * caller can correct itself; the request is never silently truncated to fit.
 */
export function refundExceedsCapturedAmountError(remainingRefundableMinorUnits: number): ApiRouteError {
  return new ApiRouteError(
    'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    'That refund is larger than the amount still available to refund on this booking.',
    { status: 422, details: { remainingRefundableMinorUnits } },
  );
}

/** `422` AC-5 — everything captured has already been refunded. */
export function alreadyFullyRefundedError(): ApiRouteError {
  return new ApiRouteError('ALREADY_FULLY_REFUNDED', 'This payment has already been fully refunded.', { status: 422 });
}

/**
 * `409` AC-7 — a retry against a refund whose provider outcome is still in flight or unknown.
 *
 * This is the error that stops a double refund: while an outcome is unknown, the only safe action
 * is to wait for the reconcile sweep's status READ, never to issue a second provider refund.
 */
export function refundAlreadyProcessingError(refundId: string): ApiRouteError {
  return new ApiRouteError(
    'REFUND_ALREADY_PROCESSING',
    'A refund on this booking is still being processed. It will complete or fail on its own; no second refund was sent.',
    { status: 409, details: { refundId } },
  );
}

/** `409` — stale `version` on a refund (spec 003 AC-6 optimistic concurrency). */
export function refundVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError('CONFLICT', `This refund was changed by someone else. Current version is ${currentVersion}; refetch and retry.`, {
    details: { currentVersion },
  });
}
