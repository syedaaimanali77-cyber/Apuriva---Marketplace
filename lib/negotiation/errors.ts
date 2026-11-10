/**
 * Spec 019 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are re-exported
 * from their owners rather than redefined, so each keeps exactly one definition.
 */
import { ApiRouteError } from '@/lib/api/errors';

export {
  notDistributedToProviderError,
  requestAlreadyClaimedError,
  requestNotActionableError,
} from '@/lib/matching/errors';
export { idempotencyKeyConflictError, requestNotFoundError } from '@/lib/requests/errors';
export { liveOfferExistsError, offerAlreadyDecidedError, offerNotFoundError } from '@/lib/offers/errors';

/** `404` — the customer has no visible thread with this provider on this request. */
export function threadNotFoundError(): ApiRouteError {
  return new ApiRouteError('THREAD_NOT_FOUND', 'There is no conversation with this provider on this request.', {
    status: 404,
  });
}

/** `422` — AC-8: the thread is read-only. */
export function threadClosedError(): ApiRouteError {
  return new ApiRouteError('THREAD_CLOSED', 'This conversation is closed. You can still read it.', { status: 422 });
}

/** `409` — AC-3: one change request per offer row. */
export function changeAlreadyRequestedError(): ApiRouteError {
  return new ApiRouteError('CHANGE_ALREADY_REQUESTED', "You've already asked for a change on this offer.", { status: 409 });
}

/** `409` — AC-5/AC-13: the offer was revised, or is not the provider's latest offer. */
export function offerSupersededError(currentOfferId: string | null): ApiRouteError {
  return new ApiRouteError('OFFER_SUPERSEDED', 'This offer was replaced by a newer one. Review the current offer.', {
    status: 409,
    details: { currentOfferId },
  });
}

/** `422` — AC-13: a revision must change at least one term. */
export function revisionUnchangedError(): ApiRouteError {
  return new ApiRouteError('REVISION_UNCHANGED', 'A revised offer must change at least one term.', { status: 422 });
}

/** `422` — AC-13: the per-(request, provider) revision cap. */
export function revisionLimitReachedError(): ApiRouteError {
  return new ApiRouteError('REVISION_LIMIT_REACHED', 'You have already revised your offer the maximum number of times.', {
    status: 422,
  });
}

/** `422` — AC-10: more than 3 offers requested. */
export function comparisonLimitExceededError(): ApiRouteError {
  return new ApiRouteError('COMPARISON_LIMIT_EXCEEDED', 'You can compare at most 3 offers.', { status: 422 });
}

/** `422` — AC-10: a supplied id is not a comparable offer on this request. Names only the caller's own ids. */
export function offerNotComparableError(offerIds: string[]): ApiRouteError {
  return new ApiRouteError('OFFER_NOT_COMPARABLE', 'One or more offers can no longer be compared.', {
    status: 422,
    details: { offerIds },
  });
}
