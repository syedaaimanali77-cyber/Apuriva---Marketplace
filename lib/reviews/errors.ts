/**
 * Spec 029 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition (the
 * pattern spec 018's `lib/offers/errors.ts` and spec 020's `lib/bookings/errors.ts` established).
 *
 * None of the new codes is in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly — exactly as spec 005's `MFA_REQUIRED` and spec 020's
 * `SLOT_NO_LONGER_AVAILABLE` do.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { ReviewIneligibilityReason, ReviewStatus } from '@/lib/types/reviews';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { bookingNotFoundError } from '@/lib/bookings/errors';

/**
 * `404` — no such review, **or** it is `removed` and the caller may not see it. The two are
 * deliberately indistinguishable so review ids cannot be probed (spec 015/018/019/020's rule).
 */
export function reviewNotFoundError(): ApiRouteError {
  return new ApiRouteError('REVIEW_NOT_FOUND', 'The requested review does not exist.', { status: 404 });
}

/** `422` AC-1 — the booking has never reached `completed`, so there is nothing verified to review. */
export function bookingNotEligibleForReviewError(reason: ReviewIneligibilityReason): ApiRouteError {
  return new ApiRouteError(
    'BOOKING_NOT_ELIGIBLE_FOR_REVIEW',
    'This booking cannot be reviewed yet. A review can only be left once the service has been completed.',
    { status: 422, details: { reason } },
  );
}

/**
 * `422` — past `completedAt + REVIEW_WINDOW_DAYS`. Carries the instant so the UI can say exactly
 * when it closed rather than computing a deadline itself (architecture §5.4).
 */
export function reviewWindowClosedError(windowClosesAt: string): ApiRouteError {
  return new ApiRouteError('REVIEW_WINDOW_CLOSED', 'The review period for this booking has closed.', {
    status: 422,
    details: { windowClosesAt },
  });
}

/** `409` AC-7 — a review already exists for this booking, including the concurrent-race loser. */
export function reviewAlreadyExistsError(): ApiRouteError {
  return new ApiRouteError('REVIEW_ALREADY_EXISTS', 'You have already reviewed this booking.', { status: 409 });
}

/**
 * `422` — a `mediaFileAssetIds` entry is not a live, `ready` `review_media` asset of the booking
 * being reviewed, uploaded by the caller.
 *
 * Deliberately `422` and not `404`: the caller is the authorized customer of a booking they can
 * already see, so there is no id to probe — the request body is simply wrong. The offending ids are
 * echoed back so a client can drop them rather than guess (spec 028's `EVIDENCE_ASSET_INVALID`).
 */
export function reviewMediaAssetInvalidError(fileAssetIds: string[]): ApiRouteError {
  return new ApiRouteError(
    'REVIEW_MEDIA_ASSET_INVALID',
    'One or more of the attached files is not a valid photo for this review.',
    { status: 422, details: { fileAssetIds } },
  );
}

/** `409` AC-3 — the review already has a provider response, and a response is never replaced. */
export function responseAlreadyExistsError(): ApiRouteError {
  return new ApiRouteError('RESPONSE_ALREADY_EXISTS', 'You have already responded to this review.', { status: 409 });
}

/** `422` — responding to a `removed` review. */
export function reviewNotRespondableError(status: ReviewStatus): ApiRouteError {
  return new ApiRouteError('REVIEW_NOT_RESPONDABLE', 'This review can no longer be responded to.', {
    status: 422,
    details: { status },
  });
}

/** `422` — reporting your own review is noise, not a signal. */
export function cannotReportOwnReviewError(): ApiRouteError {
  return new ApiRouteError('CANNOT_REPORT_OWN_REVIEW', 'You cannot report your own review.', { status: 422 });
}

/**
 * `409` — R7's `expectedStatus` no longer matches, so two admins resolving simultaneously cannot
 * silently overwrite each other. The current status lets the loser refetch and decide again.
 */
export function reviewStatusConflictError(currentStatus: ReviewStatus): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `This review was already moderated by someone else. Its status is now ${currentStatus}; refetch and retry.`,
    { details: { currentStatus } },
  );
}
