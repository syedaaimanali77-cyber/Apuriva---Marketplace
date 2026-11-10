import { ApiRouteError } from '@/lib/api/errors';

/**
 * Spec 008 §3 domain-specific error codes, extending the shared taxonomy the same way spec 005's
 * `lib/auth/errors.ts` does.
 */
export function activeBookingBlocksDeletionError(): ApiRouteError {
  return new ApiRouteError(
    'ACTIVE_BOOKING_BLOCKS_DELETION',
    'You have an active booking. Resolve it before deleting your account.',
    { status: 422 },
  );
}

export function deletionAlreadyPendingError(): ApiRouteError {
  return new ApiRouteError('DELETION_ALREADY_PENDING', 'A deletion request is already pending for this account.', {
    status: 409,
  });
}

/** Cancelling when there is no pending deletion — either none was ever requested, or the grace
 * period already elapsed and anonymization has started (spec 008 AC: cannot undo after that). */
export function deletionNotPendingError(): ApiRouteError {
  return new ApiRouteError('DELETION_NOT_PENDING', 'There is no pending deletion request to cancel.', {
    status: 409,
  });
}

/**
 * Spec 005 currently only defines MFA enrollment for admin accounts (mandatory TOTP,
 * `AdminProfile.totp_secret_encrypted`) — there is no self-service enrollment flow for a
 * non-admin account yet. Spec 008's toggle only ever flips MFA state that already exists; it
 * must not invent enrollment (secret generation, recovery codes) itself, so turning MFA on for
 * an account with nothing enrolled surfaces this instead of silently no-op'ing or faking success.
 */
export function mfaEnrollmentRequiredError(): ApiRouteError {
  return new ApiRouteError(
    'MFA_ENROLLMENT_REQUIRED',
    'MFA must be enrolled (spec 005) before it can be enabled from the Security Center.',
    { status: 422 },
  );
}

/** Spec 005 AC-5: MFA is mandatory for admin accounts — the Security Center control cannot
 * disable it. */
export function mfaDisableNotAllowedError(): ApiRouteError {
  return new ApiRouteError('MFA_DISABLE_NOT_ALLOWED', 'MFA is mandatory for this account and cannot be disabled.', {
    status: 422,
  });
}
