import { describe, expect, it } from 'vitest';
import { ENROLLMENT_TOKEN_TTL_MS, issueMfaEnrollment, readMfaEnrollmentToken } from './mfa-enrollment';

/** Spec 005 AC-5 — the first-login enrolment token: session-bound, tamper-evident and short-lived. */
describe('MFA enrolment token (spec 005 AC-5)', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);

  it('round-trips the secret for the session it was issued to', () => {
    const enrollment = issueMfaEnrollment('session-a', 'admin@example.test', now);
    expect(readMfaEnrollmentToken(enrollment.enrollmentToken, 'session-a', now + 1_000)).toBe(enrollment.secret);
    expect(enrollment.expiresAt).toBe(new Date(now + ENROLLMENT_TOKEN_TTL_MS).toISOString());
    expect(enrollment.otpauthUrl).toContain(encodeURIComponent('admin@example.test'));
  });

  it('is useless in another session, after expiry, or once altered', () => {
    const { enrollmentToken } = issueMfaEnrollment('session-a', 'admin@example.test', now);
    expect(readMfaEnrollmentToken(enrollmentToken, 'session-b', now)).toBeNull();
    expect(readMfaEnrollmentToken(enrollmentToken, 'session-a', now + ENROLLMENT_TOKEN_TTL_MS)).toBeNull();
    const [iv, tag, body] = enrollmentToken.split('.');
    const flipped = `${body!.slice(0, -2)}${body!.endsWith('A') ? 'B' : 'A'}${body!.slice(-1)}`;
    expect(readMfaEnrollmentToken(`${iv}.${tag}.${flipped}`, 'session-a', now)).toBeNull();
    expect(readMfaEnrollmentToken('not-a-token', 'session-a', now)).toBeNull();
  });

  it('never carries the secret in readable form', () => {
    const enrollment = issueMfaEnrollment('session-a', 'admin@example.test', now);
    expect(enrollment.enrollmentToken).not.toContain(enrollment.secret);
    expect(Buffer.from(enrollment.enrollmentToken.split('.')[2]!, 'base64url').toString('utf8')).not.toContain(enrollment.secret);
  });
});
