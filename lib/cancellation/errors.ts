/**
 * Spec 023 §3 "Error codes".
 *
 * None of these is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status`
 * explicitly — the pattern specs 005/016/020/021/022 already follow. Codes owned by an earlier spec
 * are RE-EXPORTED, never redefined, so one code can never mean two things.
 */
import { ApiRouteError } from '@/lib/api/errors';

export type FieldError = { field: string; message: string };

export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { bookingNotFoundError, invalidStatusTransitionError, bookingVersionConflictError } from '@/lib/bookings/errors';

/** `422` — the booking's status is outside the cancellable set (§3 "Cancellation eligibility"). */
export function bookingNotCancellableError(currentStatus: string): ApiRouteError {
  return new ApiRouteError(
    'BOOKING_NOT_CANCELLABLE',
    `A booking in "${currentStatus}" cannot be cancelled.`,
    { status: 422, details: { status: currentStatus } },
  );
}

/** `422` — a second cancellation that is not an idempotent replay. */
export function bookingAlreadyCancelledError(): ApiRouteError {
  return new ApiRouteError('BOOKING_ALREADY_CANCELLED', 'This booking has already been cancelled.', { status: 422 });
}

/**
 * `422` — no resolvable, valid policy version.
 *
 * NEVER a default-allow: with no policy nothing can be priced, so no cancellation is processed and
 * no money moves. The platform default is seeded by `0019`, so in practice this means a stored
 * configuration failed validation or an operator deactivated the default.
 */
export function cancellationPolicyUnavailableError(reason = 'no_effective_policy'): ApiRouteError {
  return new ApiRouteError(
    'CANCELLATION_POLICY_UNAVAILABLE',
    'The cancellation policy for this booking is unavailable, so no cancellation can be processed.',
    { status: 422, details: { reason } },
  );
}

/** `422` — a provider option key outside the effective version's `allowedOptions` (AC-4). */
export function policyOptionNotAllowedError(optionKey: string, allowed: readonly string[]): ApiRouteError {
  return new ApiRouteError(
    'POLICY_OPTION_NOT_ALLOWED',
    'That cancellation option is not one this service allows.',
    { status: 422, details: { optionKey, allowedOptionKeys: [...allowed] } },
  );
}

/** `422` — an admin publish whose configuration fails the grammar, naming every offending field. */
export function policyConfigInvalidError(errors: FieldError[]): ApiRouteError {
  return new ApiRouteError('POLICY_CONFIG_INVALID', 'The cancellation policy configuration is invalid.', {
    status: 422,
    errors,
  });
}

/** `409` — a publish whose validity interval overlaps an existing version for the same scope. */
export function policyVersionOverlapError(): ApiRouteError {
  return new ApiRouteError(
    'POLICY_VERSION_OVERLAP',
    'A policy version already covers that period for this scope.',
    { status: 409 },
  );
}

/**
 * `422` — no captured amount to compute against.
 *
 * Structurally unreachable from the cancellable states (spec 021's confirmation gate keeps a
 * booking `pending` until capture), so this is a defensive code: the system refuses rather than
 * guessing an amount.
 */
export function cancellationConsequenceUnavailableError(reason: string): ApiRouteError {
  return new ApiRouteError(
    'CANCELLATION_CONSEQUENCE_UNAVAILABLE',
    'The cancellation consequence for this booking cannot be determined.',
    { status: 422, details: { reason } },
  );
}
