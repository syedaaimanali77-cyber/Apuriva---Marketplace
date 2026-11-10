/**
 * Spec 030 §3 "Error codes" — the codes new to this spec. Codes reused from earlier specs are
 * re-exported from their owners rather than redefined, so each keeps exactly one definition (the
 * pattern spec 018/020/029 established).
 *
 * None of the new codes is in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { SafetyReportStatus } from '@/lib/types/safety';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';

/**
 * `404` — no such report, **or** the caller neither filed it nor may moderate it. The two are
 * deliberately indistinguishable: a `403` would confirm the report exists, which on a safety
 * surface tells a reported user they were reported. This is the rule specs 025/027/029 follow.
 */
export function safetyReportNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested safety report does not exist.', { status: 404 });
}

/** `404` — no such block, or it belongs to someone else. */
export function blockNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested block does not exist.', { status: 404 });
}

/** `404` — the target user does not exist. Never distinguishes "absent" from "not visible to you". */
export function targetUserNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested user does not exist.', { status: 404 });
}

/** `422` — blocking yourself is meaningless; `user_blocks_no_self_ck` also forbids it at the database. */
export function cannotBlockSelfError(): ApiRouteError {
  return new ApiRouteError('CANNOT_BLOCK_SELF', 'You cannot block yourself.', { status: 422 });
}

/** `422` — reporting yourself is noise, not a signal. Also forbidden by `safety_reports_no_self_ck`. */
export function cannotReportSelfError(): ApiRouteError {
  return new ApiRouteError('CANNOT_REPORT_SELF', 'You cannot file a safety report about yourself.', { status: 422 });
}

/** `409` — the requested transition is not in §3's lifecycle table. */
export function invalidSafetyTransitionError(from: SafetyReportStatus, to: SafetyReportStatus): ApiRouteError {
  return new ApiRouteError('INVALID_SAFETY_TRANSITION', `A report cannot move from ${from} to ${to}.`, {
    status: 409,
    details: { from, to },
  });
}

/**
 * `409` — `expectedStatus` no longer matches, so two admins working the queue simultaneously
 * cannot silently overwrite each other. The current status lets the loser refetch and decide again.
 */
export function safetyStatusConflictError(currentStatus: SafetyReportStatus): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `This report was already actioned by someone else. Its status is now ${currentStatus}; refetch and retry.`,
    { details: { currentStatus } },
  );
}

/** `422` — attaching to a `resolved` report, or an asset that is not the caller's live evidence. */
export function safetyEvidenceNotAttachableError(fileAssetIds: string[]): ApiRouteError {
  return new ApiRouteError(
    'SAFETY_EVIDENCE_NOT_ATTACHABLE',
    'One or more of the attached files cannot be added to this report.',
    { status: 422, details: { fileAssetIds } },
  );
}

/**
 * `422` AC-5 / DECIDED-3 — a resolution asked for a restriction but spec 038's
 * `SafetyRestrictionGate` is not registered.
 *
 * THIS DELIBERATELY THROWS RATHER THAN NO-OPPING. A resolving admin who asked for a restriction
 * must be told plainly that the capability is not installed, never left believing an account was
 * restricted when nothing happened. It is the one place this spec inverts the "a failing gate is
 * harmless" rule from `checkConversationBlock`: there, failing open preserves a live channel;
 * here, failing quiet would fabricate an enforcement outcome.
 */
export function restrictionUnavailableError(): ApiRouteError {
  return new ApiRouteError(
    'RESTRICTION_UNAVAILABLE',
    'Account restrictions are not available on this deployment. The report was not resolved; resolve it without requesting a restriction, or escalate it.',
    { status: 422 },
  );
}
