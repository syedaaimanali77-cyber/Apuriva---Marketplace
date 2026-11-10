import { describe, expect, it, beforeEach } from 'vitest';
import { GET as getSettings, PATCH as patchSettings } from './route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { authenticatedRequest, isDatabaseReachable, registerAndLogin } from '@/app/api/v1/search/search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('GET/PATCH /api/v1/users/me/personalization-settings (spec 014 §3/AC-7, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('requires a session', async () => {
    const res = await getSettings(new Request('http://localhost/api/v1/users/me/personalization-settings'));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('defaults to enabled for a freshly-registered customer', async () => {
    const user = await registerAndLogin();
    const res = await getSettings(
      authenticatedRequest('http://localhost/api/v1/users/me/personalization-settings', user.sessionId, user.csrfToken, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ personalizationEnabled: true });
  });

  it('AC-7: opts out, then reads back the change', async () => {
    const user = await registerAndLogin();
    const patchRes = await patchSettings(
      authenticatedRequest('http://localhost/api/v1/users/me/personalization-settings', user.sessionId, user.csrfToken, {
        method: 'PATCH',
        body: { personalizationEnabled: false },
      }),
    );
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).data).toEqual({ personalizationEnabled: false });

    const getRes = await getSettings(
      authenticatedRequest('http://localhost/api/v1/users/me/personalization-settings', user.sessionId, user.csrfToken, {
        method: 'GET',
      }),
    );
    expect((await getRes.json()).data).toEqual({ personalizationEnabled: false });
  });

  it('rejects a non-boolean value with 400 VALIDATION_ERROR', async () => {
    const user = await registerAndLogin();
    const res = await patchSettings(
      authenticatedRequest('http://localhost/api/v1/users/me/personalization-settings', user.sessionId, user.csrfToken, {
        method: 'PATCH',
        body: { personalizationEnabled: 'yes' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a PATCH without a CSRF token', async () => {
    const user = await registerAndLogin();
    const res = await patchSettings(
      new Request('http://localhost/api/v1/users/me/personalization-settings', {
        method: 'PATCH',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${user.sessionId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ personalizationEnabled: false }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
