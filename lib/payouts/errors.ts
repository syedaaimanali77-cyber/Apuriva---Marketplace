/**
 * Spec 024 §3.16 "Error codes" — the codes new to this spec.
 *
 * None is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly —
 * the pattern specs 005/016/020/021/022 follow. Codes owned by an earlier spec are RE-EXPORTED,
 * never redefined, so each keeps exactly one definition.
 */
import { ApiRouteError } from '@/lib/api/errors';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { stepUpRequiredError } from '@/lib/auth/errors';
export {
  adminForbiddenError,
  approvalNotEligibleError,
  approvalRequiredError,
  selfApprovalNotAllowedError,
} from '@/lib/admin-rbac/errors';

/** `404` — no such payout, or not the caller's. Deliberately indistinguishable (AC-13). */
export function payoutNotFoundError(): ApiRouteError {
  return new ApiRouteError('PAYOUT_NOT_FOUND', 'The requested payout does not exist.', { status: 404 });
}

export function payoutMethodNotFoundError(): ApiRouteError {
  return new ApiRouteError('PAYOUT_METHOD_NOT_FOUND', 'The requested payout method does not exist.', { status: 404 });
}

export function earningsLineNotFoundError(): ApiRouteError {
  return new ApiRouteError('EARNINGS_LINE_NOT_FOUND', 'The requested earnings line does not exist.', { status: 404 });
}

export function adjustmentNotFoundError(): ApiRouteError {
  return new ApiRouteError('ADJUSTMENT_NOT_FOUND', 'The requested adjustment does not exist.', { status: 404 });
}

export function payoutMethodSetupInvalidError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_METHOD_SETUP_INVALID',
    'The payout details could not be registered. Please start the payout-method setup again.',
    { status: 422 },
  );
}

export function payoutMethodInUseError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_METHOD_IN_USE',
    'This payout method is needed for a payout that is ready or in progress, so it cannot be removed yet.',
    { status: 422 },
  );
}

export function payoutMethodNotVerifiedError(): ApiRouteError {
  return new ApiRouteError('PAYOUT_METHOD_NOT_VERIFIED', 'This payout method has not been verified yet.', { status: 422 });
}

export function payoutMethodCurrencyMismatchError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_METHOD_CURRENCY_MISMATCH',
    'This payout method is in a different currency from the balance being paid.',
    { status: 422 },
  );
}

export function payoutAlreadyPaidError(): ApiRouteError {
  return new ApiRouteError('PAYOUT_ALREADY_PAID', 'This payout has already been paid.', { status: 422 });
}

export function payoutAlreadyProcessingError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_ALREADY_PROCESSING',
    'This payout is already in progress. Its outcome will be confirmed with the payout provider.',
    { status: 409 },
  );
}

export function payoutNotRetryableError(details?: Record<string, unknown>): ApiRouteError {
  return new ApiRouteError('PAYOUT_NOT_RETRYABLE', 'Only a failed payout can be retried.', { status: 422, details });
}

export function payoutRetryAlreadyPendingError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_RETRY_ALREADY_PENDING',
    'A retry for this payout is already awaiting approval.',
    { status: 409 },
  );
}

export function adjustmentAmountInvalidError(): ApiRouteError {
  return new ApiRouteError(
    'ADJUSTMENT_AMOUNT_INVALID',
    'The adjustment amount must be a positive whole number of minor units.',
    { status: 422 },
  );
}

export function adjustmentCurrencyMismatchError(): ApiRouteError {
  return new ApiRouteError(
    'ADJUSTMENT_CURRENCY_MISMATCH',
    "The adjustment currency is not one of this provider's earnings currencies.",
    { status: 422 },
  );
}

export function statementRangeInvalidError(maxDays: number): ApiRouteError {
  return new ApiRouteError(
    'STATEMENT_RANGE_INVALID',
    `Choose a valid date range of at most ${maxDays} days.`,
    { status: 422, details: { maxRangeDays: maxDays } },
  );
}

export function statementRangeTooLargeError(maxRows: number): ApiRouteError {
  return new ApiRouteError(
    'STATEMENT_RANGE_TOO_LARGE',
    `This statement would have more than ${maxRows} rows. Choose a shorter date range.`,
    { status: 422, details: { maxRows } },
  );
}

export function statementCurrencyRequiredError(): ApiRouteError {
  return new ApiRouteError(
    'STATEMENT_CURRENCY_REQUIRED',
    'You have earnings in more than one currency. Choose the currency for this statement.',
    { status: 422 },
  );
}

export function payoutProviderUnavailableError(): ApiRouteError {
  return new ApiRouteError(
    'PAYOUT_PROVIDER_UNAVAILABLE',
    'Payouts are temporarily unavailable. No payout has been changed.',
    { status: 503 },
  );
}

export function platformFeeUnconfiguredError(): ApiRouteError {
  return new ApiRouteError(
    'PLATFORM_FEE_UNCONFIGURED',
    'Earnings are temporarily unavailable. No earnings have been changed.',
    { status: 503 },
  );
}

/** `409 CONFLICT` — a stale version or a lost default-method race (spec 003 AC-6). */
export function payoutConflictError(message = 'This record changed while you were editing it. Please reload and try again.'): ApiRouteError {
  return new ApiRouteError('CONFLICT', message, { status: 409 });
}
