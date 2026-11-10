import { describe, expect, it, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { POST as requestOtp } from '@/app/api/v1/auth/otp/request/route';
import { POST as verifyOtp } from '@/app/api/v1/auth/otp/verify/route';
import { POST as register } from '@/app/api/v1/auth/register/route';
import { POST as login } from '@/app/api/v1/auth/login/route';
import { POST as oauthGoogle } from '@/app/api/v1/auth/oauth/google/route';
import { POST as oauthApple } from '@/app/api/v1/auth/oauth/apple/route';
import { POST as stepUp } from '@/app/api/v1/auth/step-up/route';
import { POST as logout } from '@/app/api/v1/auth/logout/route';
import { getSandboxSmsProvider } from '@/lib/auth/sms-otp-provider';
import { resetOtpStoreState } from '@/lib/auth/otp-store';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  authenticatedRequest,
  isDatabaseReachable,
  uniqueEmail,
  uniquePhoneNumber,
} from '@/app/api/v1/auth/test-support';

/**
 * Spec 005 §6 "E2E" row — `e2e/auth.spec.ts`.
 *
 * SCOPE, stated plainly: this drives complete authentication journeys end to end through the real
 * route handlers, the real session/CSRF/cookie machinery and a real Postgres (`*_test`), asserting
 * only on what a client can actually observe — HTTP status, response body, `Set-Cookie`. It is
 * NOT a browser test: this repository has no Playwright/Cypress dependency, and adding a browser
 * runner (plus its downloaded binaries and CI wiring) is a larger infrastructure decision than
 * spec 005 should make on its own. The UI half of these journeys is covered at component level by
 * `app/(auth)/login/page.test.tsx` and `app/(auth)/register/page.test.tsx`. If a browser E2E
 * runner is adopted later, these journeys are the ones to port first.
 */
const dbReachable = await isDatabaseReachable();

const PASSWORD = 'correct horse battery staple';

/** Threads the cookies a response sets into the next request, the way a browser would. */
function cookiesFrom(res: { cookies: { get(name: string): { value: string } | undefined } }): {
  sessionId: string;
  csrfToken: string;
} {
  const sessionId = res.cookies.get(SESSION_COOKIE_NAME)?.value;
  const csrfToken = res.cookies.get(CSRF_COOKIE_NAME)?.value;
  expect(sessionId, 'response should set a session cookie').toBeTruthy();
  expect(csrfToken, 'response should set a CSRF cookie').toBeTruthy();
  return { sessionId: sessionId!, csrfToken: csrfToken! };
}

/** The representative protected call used to prove a session is (or is not) usable. */
async function callProtectedEndpoint(sessionId: string, csrfToken: string) {
  return stepUp(
    authenticatedRequest('http://localhost/api/v1/auth/step-up', sessionId, csrfToken, {
      body: { action: 'change_payout_method' },
    }),
  );
}

describe.skipIf(!dbReachable)('authentication journeys (spec 005 E2E)', () => {
  beforeEach(() => {
    resetRateLimitState();
    resetOtpStoreState();
    getSandboxSmsProvider().reset();
  });

  it('phone + OTP login happy path: request code → verify → use session → log out → session dead', async () => {
    const phoneNumber = uniquePhoneNumber();

    // 1. Ask for a code.
    const otpRes = await requestOtp(
      new Request('http://localhost/api/v1/auth/otp/request', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber }),
      }),
    );
    expect(otpRes.status).toBe(200);
    const { data: otpData } = await otpRes.json();
    expect(new Date(otpData.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // 2. Submit it — the account is created and a session issued in one step.
    const code = getSandboxSmsProvider().getLastSentCode(phoneNumber)!;
    const verifyRes = await verifyOtp(
      new Request('http://localhost/api/v1/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ requestId: otpData.requestId, code }),
      }),
    );
    expect(verifyRes.status).toBe(200);
    const { sessionId, csrfToken } = cookiesFrom(verifyRes);

    // 3. The session works against a protected endpoint.
    expect((await callProtectedEndpoint(sessionId, csrfToken)).status).toBe(200);

    // 4. Log out.
    const logoutRes = await logout(
      authenticatedRequest('http://localhost/api/v1/auth/logout', sessionId, csrfToken),
    );
    expect(logoutRes.status).toBe(204);

    // 5. The same cookie is now worthless.
    expect((await callProtectedEndpoint(sessionId, csrfToken)).status).toBe(401);
  });

  it('failed login shows a generic error that never reveals whether the email exists', async () => {
    const registeredEmail = uniqueEmail();
    await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: registeredEmail, password: PASSWORD }),
      }),
    );

    const wrongPassword = await login(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: registeredEmail, password: 'not the right password' }),
      }),
    );
    const unknownAccount = await login(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD }),
      }),
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);

    const wrongBody = await wrongPassword.json();
    const unknownBody = await unknownAccount.json();
    // Byte-identical: an attacker learns nothing about which emails are registered (AC-3).
    expect(wrongBody.code).toBe(unknownBody.code);
    expect(wrongBody.message).toBe(unknownBody.message);
    expect(wrongBody.message).not.toContain(registeredEmail);
    expect(wrongPassword.cookies.get(SESSION_COOKIE_NAME)?.value).toBeFalsy();
  });

  it('email + password journey: register → log out → log back in with the same credentials', async () => {
    const email = uniqueEmail();

    const registerRes = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(registerRes.status).toBe(201);
    const first = cookiesFrom(registerRes);

    await logout(authenticatedRequest('http://localhost/api/v1/auth/logout', first.sessionId, first.csrfToken));
    expect((await callProtectedEndpoint(first.sessionId, first.csrfToken)).status).toBe(401);

    const loginRes = await login(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(loginRes.status).toBe(200);
    const second = cookiesFrom(loginRes);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await callProtectedEndpoint(second.sessionId, second.csrfToken)).status).toBe(200);
  });

  // AC-4 has no dedicated file in §6's traceability table, so it is covered here — it is a
  // full journey rather than a unit of logic.
  it.each([
    ['google', oauthGoogle] as const,
    ['apple', oauthApple] as const,
  ])('AC-4: %s OAuth links or creates an account and issues a session', async (providerName, route) => {
    const email = uniqueEmail();
    const code = JSON.stringify({ email, providerUserId: `${providerName}-user-1` });

    const res = await route(
      new Request(`http://localhost/api/v1/auth/oauth/${providerName}`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    );
    expect(res.status).toBe(200);

    const { data } = await res.json();
    expect(data.roles).toContain('customer');
    const { sessionId, csrfToken } = cookiesFrom(res);
    expect((await callProtectedEndpoint(sessionId, csrfToken)).status).toBe(200);

    // The provider's own credentials never reach the client.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain('providerUserId');

    // Signing in again with the same provider identity reuses the account, never duplicates it.
    const again = await route(
      new Request(`http://localhost/api/v1/auth/oauth/${providerName}`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
    );
    const { data: againData } = await again.json();
    expect(againData.userId).toBe(data.userId);

    const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });

  it('a password is never echoed back, in success or failure', async () => {
    const email = uniqueEmail();
    const registerRes = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(JSON.stringify(await registerRes.json())).not.toContain(PASSWORD);

    const failed = await login(
      new Request('http://localhost/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'wrong' }),
      }),
    );
    const failedBody = JSON.stringify(await failed.json());
    expect(failedBody).not.toContain(PASSWORD);
    expect(failedBody).not.toContain('passwordHash');

    // And it is stored hashed, never in the clear.
    const [user] = await getDb().select().from(users).where(eq(users.email, email));
    expect(user!.passwordHash).toBeTruthy();
    expect(user!.passwordHash).not.toContain(PASSWORD);
  });
});
