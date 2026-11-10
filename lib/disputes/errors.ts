/**
 * Spec 031 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition (the
 * pattern specs 018/020/029/030 established).
 *
 * None of the new codes is in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { DisputeStatus } from '@/lib/types/disputes';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';

/**
 * `404` — no such dispute, **or** the caller is neither a participant nor an authorized admin.
 *
 * The two are deliberately indistinguishable. A `403` would confirm that a dispute exists on a
 * booking, which is itself information about two other people's disagreement. This is the rule
 * specs 025/027/029/030 follow, and `requireBookingParticipant()` already behaves this way.
 */
export function disputeNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested dispute does not exist.', { status: 404 });
}

/**
 * `422` — the booking is not `protected`, or its payment protection is not `held`.
 *
 * Also the correct answer when spec 021's sweep won a race to release the protection window
 * microseconds before this transaction took the payment lock: the window really has closed.
 */
export function disputeNotEligibleError(detail?: string): ApiRouteError {
  return new ApiRouteError(
    'DISPUTE_NOT_ELIGIBLE',
    detail ??
      'This booking cannot be disputed. A dispute can only be opened while the booking is in its payment-protection window.',
    { status: 422 },
  );
}

/** `409` — a non-`closed` dispute already exists for the booking. `disputes_booking_open_uq` too. */
export function disputeAlreadyOpenError(disputeId?: string): ApiRouteError {
  return new ApiRouteError('DISPUTE_ALREADY_OPEN', 'A dispute is already open on this booking.', {
    status: 409,
    details: disputeId ? { disputeId } : undefined,
  });
}

/**
 * `403` — an admin acting on a dispute in whose booking they are a participant.
 *
 * Checked by a participation query on the booking, never by a role check, so it holds however the
 * admin acquired the role. Applies to reads as well as decisions: an admin should not be able to
 * read the other side's evidence in their own argument.
 */
export function disputeParticipantConflictError(): ApiRouteError {
  return new ApiRouteError(
    'DISPUTE_PARTICIPANT_CONFLICT',
    'You cannot act on a dispute for a booking you are part of.',
    { status: 403 },
  );
}

/** `422` — posting a message or attaching evidence while `resolved` or `closed`. */
export function disputeNotOpenError(status: DisputeStatus): ApiRouteError {
  return new ApiRouteError('DISPUTE_NOT_OPEN', `This dispute is ${status} and no longer accepts new material.`, {
    status: 422,
    details: { status },
  });
}

/** `409` — a second resolve attempt. `dispute_resolutions_dispute_uq` makes it impossible too. */
export function disputeAlreadyResolvedError(): ApiRouteError {
  return new ApiRouteError('DISPUTE_ALREADY_RESOLVED', 'This dispute has already been resolved.', { status: 409 });
}

/**
 * `409` — the dispute moved under the caller, so two admins working the queue simultaneously
 * cannot silently overwrite each other. The current status lets the loser refetch and decide again.
 */
export function disputeStatusConflictError(currentStatus: DisputeStatus): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `This dispute was already actioned by someone else. Its status is now ${currentStatus}; refetch and retry.`,
    { details: { currentStatus } },
  );
}

/** `422` — the per-dispute evidence cap, counted across both parties. */
export function disputeEvidenceLimitReachedError(max: number): ApiRouteError {
  return new ApiRouteError(
    'DISPUTE_EVIDENCE_LIMIT_REACHED',
    `A dispute can carry at most ${max} pieces of evidence.`,
    { status: 422, details: { max } },
  );
}

/** `422` — attaching an asset that is not the caller's live `dispute_evidence` upload. */
export function disputeEvidenceNotAttachableError(fileAssetId: string): ApiRouteError {
  return new ApiRouteError(
    'DISPUTE_EVIDENCE_NOT_ATTACHABLE',
    'That file cannot be attached to this dispute.',
    { status: 422, details: { fileAssetId } },
  );
}

/** `422` — the per-dispute message cap across all authors. */
export function disputeMessageLimitReachedError(max: number): ApiRouteError {
  return new ApiRouteError('DISPUTE_MESSAGE_LIMIT_REACHED', `This dispute has reached its ${max}-message limit.`, {
    status: 422,
    details: { max },
  });
}

/** `422` — an appeal filed after `DISPUTE_APPEAL_WINDOW_DAYS`. */
export function appealWindowClosedError(endsAt: string): ApiRouteError {
  return new ApiRouteError('APPEAL_WINDOW_CLOSED', 'The window to appeal this decision has closed.', {
    status: 422,
    details: { appealWindowEndsAt: endsAt },
  });
}

/** `409` — a second appeal. `dispute_appeals_dispute_uq` makes it impossible too. */
export function appealAlreadyFiledError(): ApiRouteError {
  return new ApiRouteError('APPEAL_ALREADY_FILED', 'This dispute has already been appealed.', { status: 409 });
}

/** `422` — appealing a dispute that is not `resolved` (nothing has been decided to appeal). */
export function appealNotAvailableError(status: DisputeStatus): ApiRouteError {
  return new ApiRouteError('APPEAL_NOT_AVAILABLE', `A dispute cannot be appealed while it is ${status}.`, {
    status: 422,
    details: { status },
  });
}

/**
 * `403` AC-4 — the appeal reviewer is the admin who wrote the original resolution.
 *
 * The same rule spec 009's `decideAction()` applies as `SELF_APPROVAL_NOT_ALLOWED`, applied here to
 * a decision spec 009 does not mediate.
 */
export function appealRequiresDifferentAdminError(): ApiRouteError {
  return new ApiRouteError(
    'APPEAL_REQUIRES_DIFFERENT_ADMIN',
    'An appeal must be reviewed by a different admin from the one who resolved the dispute.',
    { status: 403 },
  );
}

/**
 * `422` — closure was attempted while a proposed refund has not reached a terminal state.
 *
 * Covers both "Finance never initiated it" and "spec 022 has it `requested`/`processing`",
 * including spec 022's `unknown` provider result, which deliberately stays `processing`. A dispute
 * must never close having promised money that nobody has sent, and money must never be both
 * ambiguous and released.
 */
export function disputeRefundPendingError(refundState: string): ApiRouteError {
  return new ApiRouteError(
    'DISPUTE_REFUND_PENDING',
    'This dispute proposed a refund that has not been completed yet, so it cannot be closed.',
    { status: 422, details: { refundState } },
  );
}

/**
 * `422` — the proposed amount is not a positive integer, is in the wrong currency, or exceeds the
 * payment's refundable position.
 *
 * This spec validates the SHAPE of a proposal only. It computes no fee, no proration and no
 * remaining balance: the refundable position is read from spec 022's `readRefundablePosition()`.
 */
export function disputeRefundAmountInvalidError(detail: string): ApiRouteError {
  return new ApiRouteError('DISPUTE_REFUND_AMOUNT_INVALID', `The proposed refund is invalid: ${detail}.`, {
    status: 422,
    details: { detail },
  });
}

/** `409` — a refund approval chain is already linked to this resolution. */
export function disputeRefundAlreadyLinkedError(): ApiRouteError {
  return new ApiRouteError('CONFLICT', 'A refund approval is already linked to this resolution.', {
    details: { reason: 'refund_already_linked' },
  });
}
