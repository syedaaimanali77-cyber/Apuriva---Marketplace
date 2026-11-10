import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, securityEvents, sessions } from '@/lib/db/schema';
import { POST as register } from './register/route';
import { POST as login } from './login/route';
import { POST as mfaVerify } from './mfa/verify/route';
import { POST as mfaEnrollment } from './mfa/enrollment/route';
import { generateTotpCode } from '@/lib/auth/totp';
import { decryptTotpSecret } from '@/lib/auth/totp-secret-crypto';
import { deriveCsrfToken } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import type { MfaEnrollmentDto } from '@/lib/types/auth';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from './test-support';

/**
 * Spec 005 AC-5 — first-login TOTP enrolment. An admin who has never enrolled must still pass MFA, so the
 * login's MFA step starts with enrolment: `POST /auth/mfa/enrollment` hands out a secret and a session-bound
 * token, and `POST /auth/mfa/verify` stores the secret only once a code from it verifies.
 */
const dbReachable = await isDatabaseReachable();
const PASSWORD = 'correct horse battery staple';

/** The `{ data }` envelope these routes answer with; enrolment payloads are read through `MfaEnrollmentDto`. */
interface ApiBody {
  data: { sessionId: string; mfaRequired?: boolean; mfaEnrollmentRequired?: boolean } & Record<string, unknown>;
}

async function registerUser(): Promise<{ email: string; userId: string }> {
  const email = uniqueEmail();
  const res = await register(
    new Request('http://localhost/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) }),
  );
  expect(res.status).toBe(201);
  return { email, userId: (await res.json()).data.userId };
}

/** An admin as an operator provisions one (spec 005 §7 / spec 045 §3.9): an admin profile with NO authenticator. */
async function createUnenrolledAdmin(): Promise<{ email: string; userId: string }> {
  const user = await registerUser();
  await getDb().insert(adminProfiles).values({ userId: user.userId });
  return user;
}

async function loginAs(email: string): Promise<{ status: number; body: ApiBody }> {
  const res = await login(new Request('http://localhost/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) }));
  return { status: res.status, body: await res.json() };
}

async function startEnrollment(sessionId: string): Promise<{ status: number; body: ApiBody }> {
  const res = await mfaEnrollment(authenticatedRequest('http://localhost/api/v1/auth/mfa/enrollment', sessionId, deriveCsrfToken(sessionId), { body: {} }));
  return { status: res.status, body: await res.json() };
}

async function verify(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; body: ApiBody }> {
  const res = await mfaVerify(authenticatedRequest('http://localhost/api/v1/auth/mfa/verify', sessionId, deriveCsrfToken(sessionId), { body }));
  return { status: res.status, body: await res.json() };
}

async function storedProfile(userId: string) {
  const [row] = await getDb().select().from(adminProfiles).where(eq(adminProfiles.userId, userId));
  return row!;
}

/** A valid code that is NOT the one `generateTotpCode(secret)` gives right now (nor the steps either side). */
function wrongCode(secret: string): string {
  const valid = new Set([-30_000, 0, 30_000].map((offset) => generateTotpCode(secret, Date.now() + offset)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

describe.skipIf(!dbReachable)('first-login TOTP enrolment (spec 005 AC-5, integration)', () => {
  beforeEach(() => resetRateLimitState());

  it('an un-enrolled admin gets an MFA-pending session that says enrolment is required', async () => {
    const admin = await createUnenrolledAdmin();
    const { status, body } = await loginAs(admin.email);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: true });
    const [session] = await getDb().select().from(sessions).where(eq(sessions.id, body.data.sessionId));
    expect(session!.mfaSatisfied).toBe(false);
  });

  it('enrolment hands out a secret, an otpauth URL and a token, and stores NOTHING', async () => {
    const admin = await createUnenrolledAdmin();
    const { body: login } = await loginAs(admin.email);
    const { status, body } = await startEnrollment(login.data.sessionId);
    expect(status).toBe(200);
    const enrollment = body.data as unknown as MfaEnrollmentDto;
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollment.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Apuriva:/);
    expect(enrollment.otpauthUrl).toContain(`secret=${enrollment.secret}`);
    expect(enrollment.enrollmentToken).not.toContain(enrollment.secret);
    expect(await storedProfile(admin.userId)).toMatchObject({ totpSecretEncrypted: null, mfaEnrolledAt: null });
  });

  it('a correct first code with the token enrols the authenticator and completes the login', async () => {
    const admin = await createUnenrolledAdmin();
    const { body: login } = await loginAs(admin.email);
    const sessionId = login.data.sessionId as string;
    const enrollment = (await startEnrollment(sessionId)).body.data as unknown as MfaEnrollmentDto;

    const { status, body } = await verify(sessionId, { code: generateTotpCode(enrollment.secret), enrollmentToken: enrollment.enrollmentToken });
    expect(status).toBe(200);
    expect(body.data.mfaRequired).toBe(false);

    const profile = await storedProfile(admin.userId);
    expect(decryptTotpSecret(profile.totpSecretEncrypted!)).toBe(enrollment.secret);
    expect(profile.mfaEnrolledAt).not.toBeNull();
    const [session] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(session!.mfaSatisfied).toBe(true);
    const events = await getDb().select().from(securityEvents).where(eq(securityEvents.userId, admin.userId));
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['auth.mfa_enrollment_started', 'auth.mfa_enrolled', 'auth.mfa_succeeded']));

    // From now on the admin is enrolled: the next login asks for a code, not for enrolment, and the
    // authenticator can never be replaced from a password-only session.
    const { body: next } = await loginAs(admin.email);
    expect(next.data).toMatchObject({ mfaRequired: true, mfaEnrollmentRequired: false });
    expect((await startEnrollment(next.data.sessionId)).status).toBe(409);
    expect((await verify(next.data.sessionId, { code: generateTotpCode(enrollment.secret) })).status).toBe(200);
  });

  it('a wrong code enrols nothing and leaves the session MFA-pending', async () => {
    const admin = await createUnenrolledAdmin();
    const { body: login } = await loginAs(admin.email);
    const sessionId = login.data.sessionId as string;
    const enrollment = (await startEnrollment(sessionId)).body.data as unknown as MfaEnrollmentDto;

    const { status } = await verify(sessionId, { code: wrongCode(enrollment.secret), enrollmentToken: enrollment.enrollmentToken });
    expect(status).toBe(401);
    expect(await storedProfile(admin.userId)).toMatchObject({ totpSecretEncrypted: null, mfaEnrolledAt: null });
    const [session] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(session!.mfaSatisfied).toBe(false);
  });

  it('MFA stays mandatory: without a token, or with another session\'s token, nothing is enrolled', async () => {
    const admin = await createUnenrolledAdmin();
    const first = (await loginAs(admin.email)).body.data.sessionId as string;
    const second = (await loginAs(admin.email)).body.data.sessionId as string;
    const enrollment = (await startEnrollment(first)).body.data as unknown as MfaEnrollmentDto;
    const code = generateTotpCode(enrollment.secret);

    expect((await verify(first, { code })).status).toBe(422);
    expect((await verify(second, { code, enrollmentToken: enrollment.enrollmentToken })).status).toBe(422);
    expect((await verify(first, { code, enrollmentToken: `${enrollment.enrollmentToken}x` })).status).toBe(422);
    expect(await storedProfile(admin.userId)).toMatchObject({ totpSecretEncrypted: null, mfaEnrolledAt: null });
  });

  it('only admins can start enrolment, and only with the CSRF token', async () => {
    const user = await registerUser();
    const { body: login } = await loginAs(user.email);
    expect(login.data.mfaEnrollmentRequired).toBeUndefined();
    expect((await startEnrollment(login.data.sessionId)).status).toBe(403);

    const admin = await createUnenrolledAdmin();
    const sessionId = (await loginAs(admin.email)).body.data.sessionId as string;
    const res = await mfaEnrollment(authenticatedRequest('http://localhost/api/v1/auth/mfa/enrollment', sessionId, 'wrong-csrf', { body: {} }));
    expect(res.status).toBe(403);
  });
});
