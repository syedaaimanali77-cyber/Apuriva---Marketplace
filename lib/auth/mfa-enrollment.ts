import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './secret';
import { buildOtpAuthUrl, generateTotpSecret } from './totp';

/**
 * Spec 005 AC-5 — first-login TOTP enrolment for an admin who has never enrolled.
 *
 * Admin MFA is mandatory, so an admin with no authenticator could otherwise never complete a login
 * (`POST /auth/mfa/verify` has nothing to check against). The enrolment happens inside the same
 * MFA-pending session the password created, in two steps:
 *
 *  1. `POST /auth/mfa/enrollment` generates a fresh secret and returns it (as the manual key and an
 *     `otpauth://` URL) together with an enrolment TOKEN. Nothing is stored yet.
 *  2. `POST /auth/mfa/verify` with the first code from the authenticator AND that token. Only when the
 *     code verifies is the secret stored (`admin_profiles.totp_secret_encrypted` + `mfa_enrolled_at`),
 *     and the session marked MFA-satisfied.
 *
 * The token is the secret, the session it was issued to and an expiry, encrypted and authenticated
 * (AES-256-GCM) under a key of its own. The client cannot read or alter it, it is useless in any other
 * session, and it lapses after `ENROLLMENT_TOKEN_TTL_MS`. Keeping the unconfirmed secret out of the
 * database means an abandoned enrolment leaves nothing behind, and spec 008's "MFA is on" (a stored
 * secret) only ever reflects a CONFIRMED enrolment.
 */
export const ENROLLMENT_TOKEN_TTL_MS = 10 * 60_000;

const KEY_PURPOSE = 'mfa-enrollment-token';

interface TokenPayload {
  v: 1;
  /** The session the token was issued to. */
  s: string;
  /** The base32 TOTP secret. */
  k: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

export interface MfaEnrollment {
  secret: string;
  otpauthUrl: string;
  enrollmentToken: string;
  expiresAt: string;
}

export function issueMfaEnrollment(sessionId: string, accountLabel: string, now: number = Date.now()): MfaEnrollment {
  const secret = generateTotpSecret();
  const payload: TokenPayload = { v: 1, s: sessionId, k: secret, e: now + ENROLLMENT_TOKEN_TTL_MS };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(KEY_PURPOSE), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const enrollmentToken = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
  return { secret, otpauthUrl: buildOtpAuthUrl(secret, accountLabel), enrollmentToken, expiresAt: new Date(payload.e).toISOString() };
}

/** The secret a token carries, or `null` when it is malformed, tampered with, expired or for another session. */
export function readMfaEnrollmentToken(token: string, sessionId: string, now: number = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(KEY_PURPOSE), iv!);
    decipher.setAuthTag(tag!);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')) as TokenPayload;
    if (payload.v !== 1 || payload.s !== sessionId || typeof payload.k !== 'string' || !(payload.e > now)) return null;
    return payload.k;
  } catch {
    return null;
  }
}
