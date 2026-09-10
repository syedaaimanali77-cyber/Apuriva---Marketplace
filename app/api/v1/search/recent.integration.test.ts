import { describe, expect, it, beforeEach } from 'vitest';
import { POST as recordRecent } from './recent/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, registerAndLogin } from './search-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('POST /api/v1/search/recent (spec 013 §3, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('requires a session', async () => {
    const res = await recordRecent(new Request('http://localhost/api/v1/search/recent', { method: 'POST', body: JSON.stringify({ q: 'x' }) }));
    expect(res.status).toBe(401);
  });

  it('records a search for the caller (204)', async () => {
    const user = await registerAndLogin();
    const res = await recordRecent(
      authenticatedRequest('http://localhost/api/v1/search/recent', user.sessionId, user.csrfToken, {
        method: 'POST',
        body: { q: 'electrician' },
      }),
    );
    expect(res.status).toBe(204);
  });

  it('rejects an empty body with 400 VALIDATION_ERROR', async () => {
    const user = await registerAndLogin();
    const res = await recordRecent(
      authenticatedRequest('http://localhost/api/v1/search/recent', user.sessionId, user.csrfToken, { method: 'POST', body: {} }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});
