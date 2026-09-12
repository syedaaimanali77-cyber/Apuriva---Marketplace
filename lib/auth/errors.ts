import { ApiRouteError } from '@/lib/api/errors';

/**
 * Spec 005 §3 domain-specific error codes, extending spec 004's shared taxonomy (spec 004 §3:
 * "extends this table ... following the same SCREAMING_SNAKE_CASE and stability rule").
 */
export function mfaRequiredError(message = 'A second factor is required to complete this login.'): ApiRouteError {
  return new ApiRouteError('MFA_REQUIRED', message, { status: 401 });
}

export function csrfTokenInvalidError(): ApiRouteError {
  return new ApiRouteError('CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token.', { status: 403 });
}

export function otpAlreadyUsedError(): ApiRouteError {
  return new ApiRouteError('OTP_ALREADY_USED', 'This OTP request has already been used.', { status: 409 });
}

export function otpExpiredError(): ApiRouteError {
  return new ApiRouteError('OTP_EXPIRED', 'This code has expired — request a new one.', { status: 422 });
}

/** Spec 008 §3: any sensitive action gated by `requireStepUp` (lib/auth/step-up.ts) — a missing,
 * stale, or already-consumed step-up token, regardless of which domain endpoint required it. */
export function stepUpRequiredError(message = 'This action requires fresh step-up re-authentication.'): ApiRouteError {
  return new ApiRouteError('STEP_UP_REQUIRED', message, { status: 403 });
}
