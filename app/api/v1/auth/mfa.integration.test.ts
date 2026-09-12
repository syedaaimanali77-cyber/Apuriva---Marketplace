import { describe, expect, it, beforeEach } from 'vitest';
import { getDb } from '@/lib/db';
import { adminProfiles, sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { POST as register } from './register/route';
import { POST as login } from './login/route';
import { POST as mfaVerify } from './mfa/verify/route';
import { POST as stepUp } from './step-up/route';
import { generateTotpCode, generateTotpSecret } from '@/lib/auth/totp';
import { encryptTotpSecret } from '@/lib/auth/totp-secret-crypto';
import { deriveCsrfToken } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from './test-support';

/** Spec 005 AC-5, traceability: `mfa.integration.test.ts`. */
const dbReachable = await isDatabaseReachable();

const PASSWORD = 'correct horse battery staple';

interface AdminFixture {
  email: string;
  userId: string;
  totpSecret: string;
}

/**
 * Creates a real account, then promotes it to an admin with TOTP enrolled — the state AC-5 is
 * about. Enrolment is deliberately done directly against `admin_profiles` rather than through an
 * API: spec 005 §7 puts admin provisioning out of scope ("admin status is provisioned
 * out-of-band"), so there is no endpoint to call.
 */
async function createEnrolledAdmin(): Promise<AdminFixture> {
  const email = uniqueEmail();
  const res = await register(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(201);
  const { data } = await res.json();

  const totpSecret = generateTotpSecret();
  await getDb()
    .insert(adminProfiles)
    .values({
      userId: data.userId,
      totpSecretEncrypted: encryptTotpSecret(totpSecret),
      mfaEnrolledAt: new Date(),
    });

  return { email, userId: data.userId, totpSecret };
}

async function loginAs(email: string): Promise<{ status: number; body: any }> {
  const res = await login(
    new Request('http://localhost/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

function mfaRequest(sessionId: string, code: string): Request {
  return authenticatedRequest('http://localhost/api/v1/auth/mfa/verify', sessionId, deriveCsrfToken(sessionId), {
    body: { code },
  });
}

describe.skipIf(!dbReachable)('admin login requires mfa (spec 005 AC-5, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-5: an admin login is issued only a partial, MFA-pending session', async () => {
    const admin = await createEnrolledAdmin();

    const { status, body } = await loginAs(admin.email);
    expect(status).toBe(200);
    expect(body.data.mfaRequired).toBe(true);
    expect(body.data.roles).toContain('admin');

    // Server-side truth, not just the DTO: the session row itself is unsatisfied.
    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, body.data.sessionId));
    expect(row!.mfaSatisfied).toBe(false);
  });

  it('AC-5: the MFA-pending session is rejected by a normal protected endpoint until the second factor lands', async () => {
    const admin = await createEnrolledAdmin();
    const { body } = await loginAs(admin.email);
    const sessionId = body.data.sessionId;

    const blocked = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, deriveCsrfToken(sessionId), {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(blocked.status).toBe(401);
    expect((await blocked.json()).code).toBe('MFA_REQUIRED');
  });

  it('AC-5: a valid TOTP code completes the login and makes the same session usable', async () => {
    const admin = await createEnrolledAdmin();
    const { body } = await loginAs(admin.email);
    const sessionId = body.data.sessionId;

    const verified = await mfaVerify(mfaRequest(sessionId, generateTotpCode(admin.totpSecret)));
    expect(verified.status).toBe(200);
    const { data } = await verified.json();
    expect(data.mfaRequired).toBe(false);
    expect(data.sessionId).toBe(sessionId);

    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.mfaSatisfied).toBe(true);

    const allowed = await stepUp(
      authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, deriveCsrfToken(sessionId), {
        body: { action: 'change_payout_method' },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it('AC-5: an incorrect second factor is rejected and leaves the session unsatisfied', async () => {
    const admin = await createEnrolledAdmin();
    const { body } = await loginAs(admin.email);
    const sessionId = body.data.sessionId;

    const rejected = await mfaVerify(mfaRequest(sessionId, '000000'));
    expect(rejected.status).toBe(401);
    expect((await rejected.json()).code).toBe('UNAUTHENTICATED');

    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.mfaSatisfied).toBe(false);
  });

  it('AC-5: a TOTP code generated from a different secret never satisfies MFA', async () => {
    const admin = await createEnrolledAdmin();
    const { body } = await loginAs(admin.email);

    const someoneElsesCode = generateTotpCode(generateTotpSecret());
    const rejected = await mfaVerify(mfaRequest(body.data.sessionId, someoneElsesCode));
    expect(rejected.status).toBe(401);
  });

  it('AC-7 boundary: the MFA endpoint still enforces CSRF — a forged token cannot complete a login', async () => {
    const admin = await createEnrolledAdmin();
    const { body } = await loginAs(admin.email);
    const sessionId = body.data.sessionId;

    const forged = authenticatedRequest(
      'http://localhost/api/v1/auth/mfa/verify',
      sessionId,
      deriveCsrfToken('some-other-session-id'),
      { body: { code: generateTotpCode(admin.totpSecret) } },
    );
    const res = await mfaVerify(forged);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CSRF_TOKEN_INVALID');
  });

  it('a non-admin account is never sent down the MFA path at all', async () => {
    const email = uniqueEmail();
    await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );

    const { body } = await loginAs(email);
    expect(body.data.mfaRequired).toBe(false);
    expect(body.data.roles).not.toContain('admin');
  });

  it('an admin without TOTP enrolled cannot complete MFA (no silent bypass)', async () => {
    const email = uniqueEmail();
    const res = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    const { data } = await res.json();
    // Admin, but enrolment never happened.
    await getDb().insert(adminProfiles).values({ userId: data.userId });

    const { body } = await loginAs(email);
    expect(body.data.mfaRequired).toBe(true);

    const attempted = await mfaVerify(mfaRequest(body.data.sessionId, '123456'));
    expect(attempted.status).toBe(422);
    expect((await attempted.json()).code).toBe('DOMAIN_RULE_VIOLATION');
  });
});
