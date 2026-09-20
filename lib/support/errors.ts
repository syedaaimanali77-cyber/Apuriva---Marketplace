/**
 * Spec 032 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition (the
 * pattern specs 018/020/029/030/031 established).
 *
 * None of the new codes is in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { SupportTicketStatus } from '@/lib/types/support';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';

/**
 * `404` — no such ticket, **or** the caller is neither its requester nor a `support/read` admin.
 *
 * The two are deliberately indistinguishable. A `403` would confirm that a given ticket id exists,
 * which is itself information about someone else's problem. This is the rule specs
 * 025/027/029/030/031 follow, and `requireBookingParticipant()` already behaves this way.
 */
export function supportTicketNotFoundError(): ApiRouteError {
  return new ApiRouteError('SUPPORT_TICKET_NOT_FOUND', 'The requested support ticket does not exist.', {
    status: 404,
  });
}

/**
 * `403` — an admin acting on a ticket they themselves raised (DECIDED-9).
 *
 * The exact mirror of spec 031's `DISPUTE_PARTICIPANT_CONFLICT`. Checked BEFORE the permission
 * check, so the error names the real reason rather than a permission they in fact hold. They keep
 * full access as the requester through the participant routes.
 */
export function supportParticipantConflictError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_PARTICIPANT_CONFLICT',
    'You cannot act as an admin on a support ticket you raised yourself.',
    { status: 403 },
  );
}

/** `409` — `expectedStatus` did not match, or a concurrent transition won the race (AC-7). */
export function supportStatusConflictError(currentStatus: SupportTicketStatus): ApiRouteError {
  return new ApiRouteError('SUPPORT_TICKET_STATUS_CONFLICT', 'This ticket has already changed status.', {
    status: 409,
    details: { currentStatus },
  });
}

/** `422` — the `(from, to, actor)` triple is not in the transition table, `closed` included. */
export function supportTransitionNotAllowedError(from: SupportTicketStatus, to: SupportTicketStatus): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_TRANSITION_NOT_ALLOWED',
    `A support ticket cannot move from '${from}' to '${to}'.`,
    { status: 422, details: { from, to } },
  );
}

/** `422` — a message or attachment attempted on a `resolved`/`closed` ticket. */
export function supportTicketClosedError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_TICKET_CLOSED',
    'This ticket is no longer open for replies or attachments.',
    { status: 422 },
  );
}

/**
 * `422` — AC-2's single, UNIFORM answer for every context failure.
 *
 * Unknown id, malformed uuid, deleted row and a real object the caller has no relationship to all
 * produce this exact code and this exact message, so the route cannot be used to enumerate
 * bookings, payments or disputes. The message is deliberately constant — no detail, no id echo.
 */
export function supportContextNotAvailableError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_CONTEXT_NOT_AVAILABLE',
    'That item cannot be attached to a support ticket.',
    { status: 422 },
  );
}

/** `409` — the requester has already used their one reopen. */
export function supportReopenLimitReachedError(): ApiRouteError {
  return new ApiRouteError('SUPPORT_REOPEN_LIMIT_REACHED', 'This ticket has already been reopened once.', {
    status: 409,
  });
}

/** `422` — a reopen attempted after the window closed. */
export function supportReopenWindowElapsedError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_REOPEN_WINDOW_ELAPSED',
    'The period for reopening this ticket has passed. Please open a new ticket.',
    { status: 422 },
  );
}

/** `422` — the assignment target does not hold `support/respond`. */
export function supportAssigneeNotEligibleError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_ASSIGNEE_NOT_ELIGIBLE',
    'That admin cannot be assigned support tickets.',
    { status: 422 },
  );
}

/**
 * `422` — the resolution does not hold together.
 *
 * Covers `handed_off` without a target, a `safety` ticket resolved `answered` (AC-9 — also refused
 * by `support_tickets_safety_resolution_ck`, so this is the friendly half of a guarantee the
 * database makes independently), a safety handoff without a `targetUserId`, and a dispute handoff
 * without a reachable `disputeId`.
 */
export function supportResolutionInvalidError(detail: string): ApiRouteError {
  return new ApiRouteError('SUPPORT_RESOLUTION_INVALID', detail, { status: 422 });
}

/** `422` — `MAX_SUPPORT_MESSAGES` reached for this ticket. */
export function supportMessageLimitReachedError(): ApiRouteError {
  return new ApiRouteError(
    'SUPPORT_MESSAGE_LIMIT_REACHED',
    'This ticket has reached its message limit. A support admin will follow up.',
    { status: 422 },
  );
}
