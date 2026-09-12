/** Spec 005 §3 request/response types. */
export interface SessionDto {
  userId: string;
  sessionId: string;
  expiresAt: string;
  mfaRequired: boolean;
  roles: Array<'customer' | 'provider' | 'admin'>;
}

export interface RequestOtpRequest {
  phoneNumber: string; // E.164
}

export interface VerifyOtpRequest {
  requestId: string;
  code: string;
}
