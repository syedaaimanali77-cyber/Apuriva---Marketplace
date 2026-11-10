/** Spec 005 §3 request/response types. */
export interface SessionDto {
  userId: string;
  sessionId: string;
  expiresAt: string;
  mfaRequired: boolean;
  /**
   * Spec 005 AC-5 (additive): the admin has never enrolled an authenticator, so the MFA step must start
   * with `POST /api/v1/auth/mfa/enrollment` before the first code can be verified.
   */
  mfaEnrollmentRequired?: boolean;
  roles: Array<'customer' | 'provider' | 'admin'>;
}

/** Spec 005 AC-5 — `POST /api/v1/auth/mfa/enrollment`. Nothing is stored until a code confirms it. */
export interface MfaEnrollmentDto {
  /** Base32 key for manual entry in an authenticator app. */
  secret: string;
  otpauthUrl: string;
  /** Opaque; sent back with the first code to `POST /api/v1/auth/mfa/verify`. Bound to this session. */
  enrollmentToken: string;
  expiresAt: string;
}

export interface RequestOtpRequest {
  phoneNumber: string; // E.164
}

export interface VerifyOtpRequest {
  requestId: string;
  code: string;
}
