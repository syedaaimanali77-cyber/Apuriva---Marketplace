/**
 * Spec 018 §3 "Error codes" — the four codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition.
 */
import { ApiRouteError } from '@/lib/api/errors';

export {
  actionNotAvailableForPricingModelError,
  notDistributedToProviderError,
  requestAlreadyClaimedError,
  requestNotActionableError,
} from '@/lib/matching/errors';
export { idempotencyKeyConflictError, requestNotFoundError } from '@/lib/requests/errors';

/** `404` — the offer does not exist, or the caller is neither its customer nor its provider. The two
 *  cases are indistinguishable so offer ids cannot be probed. */
export function offerNotFoundError(): ApiRouteError {
  return new ApiRouteError('OFFER_NOT_FOUND', 'The requested offer does not exist.', { status: 404 });
}

/** `409` — AC-5: the provider already holds a live offer on this request. */
export function liveOfferExistsError(): ApiRouteError {
  return new ApiRouteError(
    'LIVE_OFFER_EXISTS',
    'You already have an offer waiting on this request. Withdraw it or wait for it to expire first.',
    { status: 409 },
  );
}

/** `409` — AC-6/AC-8: the offer is already in a different terminal state. */
export function offerAlreadyDecidedError(status: string): ApiRouteError {
  return new ApiRouteError('OFFER_ALREADY_DECIDED', `This offer has already been ${status}.`, { status: 409 });
}

/** `422` — AC-1: the database clock is at or past `expires_at`. */
export function offerExpiredError(): ApiRouteError {
  return new ApiRouteError('OFFER_EXPIRED', 'This offer expired — the provider can send a new one.', { status: 422 });
}
