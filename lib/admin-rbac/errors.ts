import { ApiRouteError, validationError } from '@/lib/api/errors';

/**
 * Spec 009 §3 domain-specific error codes, extending the shared taxonomy the same way spec 005's
 * `lib/auth/errors.ts` and spec 008's `lib/privacy/errors.ts` do.
 */

/** AC-1: an authenticated admin lacking a `Permission` matching `(resource, action)` for any of
 * their assigned roles — always server-side, regardless of frontend menu visibility. */
export function adminForbiddenError(message = 'You do not have permission to perform this action.'): ApiRouteError {
  return new ApiRouteError('FORBIDDEN', message);
}

/** §3 `409 SELF_APPROVAL_NOT_ALLOWED` — the same admin who initiated an `AdminAction` attempts to
 * approve or reject it. */
export function selfApprovalNotAllowedError(): ApiRouteError {
  return new ApiRouteError(
    'SELF_APPROVAL_NOT_ALLOWED',
    'The admin who initiated this action cannot approve or reject it.',
    { status: 409 },
  );
}

/** §3/§4.2 `409 APPROVAL_NOT_ELIGIBLE` — the approver lacks the required scope, or the
 * `AdminAction` is not in the status this decision requires (already decided, executed, or
 * otherwise terminal). Also used for a post-action-review attempt outside
 * `PostActionReviewRequired`. */
export function approvalNotEligibleError(
  message = 'This action is not eligible for that decision.',
): ApiRouteError {
  return new ApiRouteError('APPROVAL_NOT_ELIGIBLE', message, { status: 409 });
}

/** AC-5/§3 `409 LAST_SUPER_ADMIN` — a role revocation would leave zero remaining `super_admin`
 * holders. */
export function lastSuperAdminError(): ApiRouteError {
  return new ApiRouteError(
    'LAST_SUPER_ADMIN',
    'This would leave zero remaining Super Admins. Assign another Super Admin first.',
    { status: 409 },
  );
}

/** §3.1 step 3/§3 `422 APPROVAL_REQUIRED` — a high/critical-risk action was attempted to execute
 * directly instead of via the approval (or declared emergency-bypass) flow. */
export function approvalRequiredError(): ApiRouteError {
  return new ApiRouteError(
    'APPROVAL_REQUIRED',
    'This high/critical-risk action requires the approval (or declared emergency-bypass) flow.',
    { status: 422 },
  );
}

export function adminActionNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'Admin action not found.');
}

export function unknownAdminError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'No such admin.');
}

export function roleNotAssignedError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'This admin does not hold that role.');
}

export function invalidRoleError(role: unknown): ApiRouteError {
  return validationError([{ field: 'role', message: `"${String(role)}" is not one of the seven canonical admin roles.` }]);
}
