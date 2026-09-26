/**
 * Spec 038 §3.15 "Error codes" — the codes new to this spec.
 *
 * Codes owned by an earlier spec are RE-EXPORTED, never redefined, so one code can never mean two
 * things (the pattern specs 018/020/023/029/030 established). None of the new codes is in spec 004's
 * shared `API_ERROR_CODES` map, so each passes `options.status` explicitly.
 */
import { ApiRouteError } from '@/lib/api/errors';

export { idempotencyKeyConflictError } from '@/lib/requests/errors';
export { adminForbiddenError, approvalNotEligibleError, approvalRequiredError } from '@/lib/admin-rbac/errors';

/** `404` — unknown action, or (on the user routes) an action that is not the caller's. */
export function moderationActionNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested moderation action does not exist.', { status: 404 });
}

export function fraudSignalNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested fraud signal does not exist.', { status: 404 });
}

export function moderationAppealNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested appeal does not exist.', { status: 404 });
}

/** `404` — the named user, provider profile or booking does not exist (or does not belong together). */
export function moderationTargetNotFoundError(field: string): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', `The requested ${field} does not exist.`, { status: 404, details: { field } });
}

/** `409` — not strictly more severe, a pending action exists, or an open freeze/intervention exists. */
export function moderationActionConflictError(message: string, details?: Record<string, unknown>): ApiRouteError {
  return new ApiRouteError('MODERATION_ACTION_CONFLICT', message, { status: 409, details });
}

/** `409` — execute/reverse from the wrong status, or a second execution. */
export function moderationStatusConflictError(currentStatus: string): ApiRouteError {
  return new ApiRouteError(
    'MODERATION_STATUS_CONFLICT',
    `This moderation action cannot do that in its current status (${currentStatus}).`,
    { status: 409, details: { currentStatus } },
  );
}

/** `409` — a deleted account, an account holding an AdminProfile, or an already-banned profile. */
export function targetNotModeratableError(reason: 'account_deleted' | 'admin_account' | 'provider_banned'): ApiRouteError {
  return new ApiRouteError('TARGET_NOT_MODERATABLE', 'This target cannot be moderated.', { status: 409, details: { reason } });
}

/** `409` — a reversal found a lifecycle column no longer at the value this action set. Nothing written. */
export function lifecycleStateChangedError(): ApiRouteError {
  return new ApiRouteError(
    'LIFECYCLE_STATE_CHANGED',
    'The account or profile status changed since this action was applied; nothing was reversed.',
    { status: 409 },
  );
}

export function fraudSignalStatusConflictError(currentStatus: string): ApiRouteError {
  return new ApiRouteError(
    'FRAUD_SIGNAL_STATUS_CONFLICT',
    `This signal cannot move from its current status (${currentStatus}).`,
    { status: 409, details: { currentStatus } },
  );
}

export function appealAlreadyFiledError(): ApiRouteError {
  return new ApiRouteError('APPEAL_ALREADY_FILED', 'An appeal has already been filed for this action.', { status: 409 });
}

export function appealNotAvailableError(): ApiRouteError {
  return new ApiRouteError('APPEAL_NOT_AVAILABLE', 'This action cannot be appealed.', { status: 409 });
}

export function appealStatusConflictError(currentStatus: string): ApiRouteError {
  return new ApiRouteError('APPEAL_STATUS_CONFLICT', `This appeal has already been decided (${currentStatus}).`, {
    status: 409,
    details: { currentStatus },
  });
}

/** `403` — the decider initiated or approved the appealed action (AC-5). */
export function appealRequiresDifferentAdminError(): ApiRouteError {
  return new ApiRouteError(
    'APPEAL_REQUIRES_DIFFERENT_ADMIN',
    'An appeal must be decided by an admin who neither initiated nor approved the action.',
    { status: 403 },
  );
}

/** §3.5 standing enforcement — thrown only by `lib/moderation/standing.ts`. */
export function accountRestrictedError(): ApiRouteError {
  return new ApiRouteError('ACCOUNT_RESTRICTED', 'Your account is restricted and cannot start new marketplace activity.', { status: 403 });
}

export function accountSuspendedError(): ApiRouteError {
  return new ApiRouteError('ACCOUNT_SUSPENDED', 'Your account is suspended.', { status: 403 });
}

export function accountBannedError(): ApiRouteError {
  return new ApiRouteError('ACCOUNT_BANNED', 'Your account is banned.', { status: 403 });
}

export function providerNotInGoodStandingError(standing: string): ApiRouteError {
  return new ApiRouteError('PROVIDER_NOT_IN_GOOD_STANDING', 'This provider cannot take on new work right now.', {
    status: 403,
    details: { standing },
  });
}
