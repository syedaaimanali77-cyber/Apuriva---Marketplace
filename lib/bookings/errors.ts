/**
 * Spec 020 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition
 * (spec 018's `lib/offers/errors.ts` established this pattern).
 *
 * None of the new codes is in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly — exactly as spec 005's `MFA_REQUIRED`, spec 016's `SLOT_OVERLAP`
 * and spec 018's `OFFER_EXPIRED` do.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { SlotUnavailableDetails } from '@/lib/types/bookings';

export { requestNotActionableError } from '@/lib/matching/errors';
export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { offerNotFoundError } from '@/lib/offers/errors';

/**
 * `404` — no such booking, **or** the caller is not a participant. The two cases are deliberately
 * indistinguishable so booking ids cannot be probed (spec 015/018/019's rule). `403` is reserved
 * for a wrong active mode.
 */
export function bookingNotFoundError(): ApiRouteError {
  return new ApiRouteError('BOOKING_NOT_FOUND', 'The requested booking does not exist.', { status: 404 });
}

/**
 * `422` AC-2 — the slot was revalidated at confirmation time and is gone. Always carries the full
 * `details` object, never an empty body: `requestedStartAt`, `durationMinutes`,
 * `scheduledTimezone`, 0–3 re-submittable `alternatives` and the `nextAvailableDate` fallback.
 *
 * Spec 016's `SLOT_OVERLAP` message is deliberately NOT forwarded into this error: it can name the
 * conflicting interval's `sourceId`, which spec 016 §3 restricts to the owning provider.
 */
export function slotNoLongerAvailableError(details: SlotUnavailableDetails): ApiRouteError {
  return new ApiRouteError(
    'SLOT_NO_LONGER_AVAILABLE',
    'This time is no longer available. Choose one of the suggested times instead.',
    { status: 422, details: details as unknown as Record<string, unknown> },
  );
}

/** `422` AC-1 step 9 — the offer is not `accepted` (superseded, decided otherwise, expired, or live). */
export function offerNotAcceptableError(reason: string, status: string): ApiRouteError {
  const message =
    reason === 'superseded'
      ? 'That offer was replaced by a revised offer, so it can no longer be booked.'
      : reason === 'not_accepted'
        ? 'That offer has not been accepted yet, so it cannot be booked.'
        : `That offer was ${status}, so it can no longer be booked.`;
  return new ApiRouteError('OFFER_NOT_ACCEPTABLE', message, { status: 422, details: { reason, status } });
}

/** `409` AC-1 step 8 — a booking already exists for this offer under a different idempotency key. */
export function bookingAlreadyExistsError(bookingId: string): ApiRouteError {
  return new ApiRouteError('BOOKING_ALREADY_EXISTS', 'A booking already exists for this offer.', {
    status: 409,
    details: { bookingId },
  });
}

/** `409` AC-6 — a status change outside the seeded transition graph. */
export function invalidStatusTransitionError(currentStatus: string): ApiRouteError {
  return new ApiRouteError(
    'INVALID_STATUS_TRANSITION',
    `This booking is ${currentStatus.replace(/_/g, ' ')}, so that action is not available.`,
    { status: 409, details: { currentStatus } },
  );
}

/** `409` AC-6 — stale `expectedVersion` (spec 003 AC-6); the current version lets the client refetch. */
export function bookingVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `This booking was changed by someone else. Current version is ${currentVersion}; refetch and retry.`,
    { details: { currentVersion } },
  );
}

/** `422` AC-5 — the completion-evidence gate reports `required && !satisfied`. */
export function completionEvidenceRequiredError(): ApiRouteError {
  return new ApiRouteError(
    'COMPLETION_EVIDENCE_REQUIRED',
    'This service needs completion evidence attached before it can be marked complete.',
    { status: 422 },
  );
}

/** `422` AC-11 safeguard S3 — the minimum in-progress dwell has not elapsed on the database clock. */
export function completionTooEarlyError(retryAfterSeconds: number): ApiRouteError {
  return new ApiRouteError(
    'COMPLETION_TOO_EARLY',
    'This booking has only just started. You can mark it complete in a moment.',
    { status: 422, details: { retryAfterSeconds } },
  );
}

/** `422` AC-11 safeguard S4 — more than the early-start grace before `scheduled_at`. */
export function bookingNotStartableYetError(startableFrom: string): ApiRouteError {
  return new ApiRouteError('BOOKING_NOT_STARTABLE_YET', 'It is too early to start this booking.', {
    status: 422,
    details: { startableFrom },
  });
}

/**
 * `422` spec 028 AC-6 — an `evidenceFileAssetIds` entry is not a live, `ready` `booking_evidence`
 * asset of the booking being completed.
 *
 * Deliberately `422` and not `404`: the caller is an authorized participant of a booking they can
 * already see, so there is no id to probe here — the request body is simply wrong. The offending
 * ids are echoed back so a client can drop them rather than guess.
 */
export function evidenceAssetInvalidError(fileAssetIds: string[]): ApiRouteError {
  return new ApiRouteError(
    'EVIDENCE_ASSET_INVALID',
    'One or more of the attached files is not valid completion evidence for this booking.',
    { status: 422, details: { fileAssetIds } },
  );
}

/** `422` spec 028 AC-3 — a milestone posted outside `arrived`/`in_progress`. */
export function milestoneNotAllowedInStatusError(currentStatus: string): ApiRouteError {
  return new ApiRouteError(
    'MILESTONE_NOT_ALLOWED_IN_STATUS',
    `This booking is ${currentStatus.replace(/_/g, ' ')}, so progress updates cannot be posted.`,
    { status: 422, details: { currentStatus } },
  );
}
