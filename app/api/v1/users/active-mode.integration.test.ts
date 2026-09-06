import { describe, expect, it, beforeEach } from 'vitest';
import { POST as register } from '../auth/register/route';
import { GET as getMe } from './me/route';
import { POST as becomeProvider } from './me/provider-profile/route';
import { PATCH as switchMode } from './me/active-mode/route';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from '../auth/test-support';

/** Spec 006 AC-2/AC-4/AC-5, traceability: `active-mode.integration.test.ts`. */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('PATCH /api/v1/users/me/active-mode (spec 006 AC-2/AC-4/AC-5, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  async function registerAndLogin(): Promise<{ sessionId: string; csrfToken: string }> {
    const res = await register(
      new Request('http://localhost/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail(), password: 'correct horse battery staple' }),
      }),
    );
    const { data } = await res.json();
    const csrfCookie = res.cookies.get(CSRF_COOKIE_NAME)?.value!;
    return { sessionId: data.sessionId, csrfToken: csrfCookie };
  }

  it('AC-4/missing-profile rejection: switching to provider without a ProviderProfile returns 422 PROFILE_NOT_FOUND_FOR_MODE', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await switchMode(
      authenticatedRequest('http://localhost/api/v1/users/me/active-mode', sessionId, csrfToken, {
        method: 'PATCH',
        body: { mode: 'provider' },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PROFILE_NOT_FOUND_FOR_MODE');
  });

  it('AC-2: switches mode on the session once the profile exists, and it is reflected on /users/me', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    await becomeProvider(authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', sessionId, csrfToken));

    const res = await switchMode(
      authenticatedRequest('http://localhost/api/v1/users/me/active-mode', sessionId, csrfToken, {
        method: 'PATCH',
        body: { mode: 'provider' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.activeMode).toBe('provider');

    const me = await getMe(authenticatedRequest('http://localhost/api/v1/users/me', sessionId, csrfToken, { method: 'GET' }));
    expect((await me.json()).data.activeMode).toBe('provider');
  });

  it('AC-5: the mode set on one session does not affect a second, independent session for the same user', async () => {
    const email = uniqueEmail();
    const password = 'correct horse battery staple';
    const first = await register(
      new Request('http://localhost/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
    );
    const firstData = (await first.json()).data;
    const firstCsrf = first.cookies.get(CSRF_COOKIE_NAME)?.value!;

    await becomeProvider(authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', firstData.sessionId, firstCsrf));
    await switchMode(
      authenticatedRequest('http://localhost/api/v1/users/me/active-mode', firstData.sessionId, firstCsrf, {
        method: 'PATCH',
        body: { mode: 'provider' },
      }),
    );

    // A second login (spec 005 login, not register) issues an independent session for the same user.
    const { POST: login } = await import('../auth/login/route');
    const second = await login(
      new Request('http://localhost/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    );
    const secondData = (await second.json()).data;
    const secondCsrf = second.cookies.get(CSRF_COOKIE_NAME)?.value!;

    const secondMe = await getMe(
      authenticatedRequest('http://localhost/api/v1/users/me', secondData.sessionId, secondCsrf, { method: 'GET' }),
    );
    expect((await secondMe.json()).data.activeMode).toBe('customer'); // fresh session default, unaffected by the first
  });

  it('validation: rejects an invalid mode value with 400 VALIDATION_ERROR', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await switchMode(
      authenticatedRequest('http://localhost/api/v1/users/me/active-mode', sessionId, csrfToken, {
        method: 'PATCH',
        body: { mode: 'admin' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
