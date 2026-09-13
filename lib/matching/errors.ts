/**
 * Spec 017 §3 "Error codes" — extends spec 004's `API_ERROR_CODES` table in the established
 * SCREAMING_SNAKE_CASE + stability way. Codes outside the shared baseline map pass
 * `options.status` explicitly, exactly as specs 005 and 016 already do.
 */
import { ApiRouteError } from '@/lib/api/errors';

export interface FieldError {
  field: string;
  message: string;
}

/** `403` — the provider was never distributed into this request. Checked before anything else, so
 *  a provider cannot probe request ids by observing which ones return a different status. */
export function notDistributedToProviderError(): ApiRouteError {
  return new ApiRouteError(
    'NOT_DISTRIBUTED_TO_PROVIDER',
    'This request was not distributed to you.',
    { status: 403 },
  );
}

/** `409` — AC-5's claim invariant: another provider already accepted this request. */
export function requestAlreadyClaimedError(): ApiRouteError {
  return new ApiRouteError(
    'REQUEST_ALREADY_CLAIMED',
    'Another provider has already taken this request.',
    { status: 409 },
  );
}

/** `422` — "Accept" attempted on a `quote`/`custom` service, whose action is "Send Offer" (spec 018). */
export function actionNotAvailableForPricingModelError(pricingModel: string): ApiRouteError {
  return new ApiRouteError(
    'ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL',
    `A ${pricingModel}-priced service cannot be accepted directly; send an offer instead.`,
    { status: 422 },
  );
}

/** `422` — the request is cancelled/expired/already progressed, or a conflicting second action. */
export function requestNotActionableError(reason: string): ApiRouteError {
  return new ApiRouteError('REQUEST_NOT_ACTIONABLE', reason, { status: 422 });
}

/** `422` — weights missing a factor, out of range, not summing to 100, or a bad pool size. */
export function invalidMatchingWeightsError(errors: FieldError[]): ApiRouteError {
  return new ApiRouteError('INVALID_MATCHING_WEIGHTS', 'The matching configuration is invalid.', {
    status: 422,
    errors,
  });
}

/** `409` — approve/reject attempted on a suggestion that is no longer `pending_review`. */
export function suggestionAlreadyReviewedError(): ApiRouteError {
  return new ApiRouteError(
    'SUGGESTION_ALREADY_REVIEWED',
    'This suggestion has already been reviewed.',
    { status: 409 },
  );
}

export function matchingNotFoundError(what = 'The requested resource does not exist.'): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', what);
}

/** `409` — stale `expectedVersion` on a weights update (spec 003 AC-6 optimistic concurrency). */
export function matchingVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `This service was changed by someone else. Current version is ${currentVersion}; refetch and retry.`,
  );
}
