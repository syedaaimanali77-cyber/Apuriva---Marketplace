import { describe, expect, it, beforeEach } from 'vitest';
import { POST as register } from '../auth/register/route';
import { GET as getMe } from './me/route';
import { POST as becomeProvider } from './me/provider-profile/route';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from '../auth/test-support';

/** Spec 006 AC-1, traceability: `provider-profile.integration.test.ts`. */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('POST /api/v1/users/me/provider-profile (spec 006 AC-1, integration)', () => {
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

  it('creates without a new account or a session mode change (201)', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();

    const before = await getMe(authenticatedRequest('http://localhost/api/v1/users/me', sessionId, csrfToken, { method: 'GET' }));
    const beforeBody = (await before.json()).data;
    expect(beforeBody.hasProviderProfile).toBe(false);
    expect(beforeBody.activeMode).toBe('customer');

    const res = await becomeProvider(
      authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', sessionId, csrfToken),
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.lifecycleStatus).toBe('draft');

    const after = await getMe(authenticatedRequest('http://localhost/api/v1/users/me', sessionId, csrfToken, { method: 'GET' }));
    const afterBody = (await after.json()).data;
    expect(afterBody.id).toBe(beforeBody.id); // same user/account
    expect(afterBody.hasProviderProfile).toBe(true);
    expect(afterBody.activeMode).toBe('customer'); // unchanged — AC-1
  });

  it('is idempotent — a second call returns the same profile without creating a duplicate (200)', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();

    const first = await becomeProvider(
      authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', sessionId, csrfToken),
    );
    const firstBody = (await first.json()).data;

    const second = await becomeProvider(
      authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', sessionId, csrfToken),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()).data;
    expect(secondBody.id).toBe(firstBody.id);
  });

  it('a freshly registered user already has a CustomerProfile (spec 006 §1)', async () => {
    const { sessionId, csrfToken } = await registerAndLogin();
    const res = await getMe(authenticatedRequest('http://localhost/api/v1/users/me', sessionId, csrfToken, { method: 'GET' }));
    expect((await res.json()).data.hasCustomerProfile).toBe(true);
  });
});
