import { beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { FEATURE_FLAG_REGISTRY } from '@/lib/feature-flags/registry';
import { isDatabaseReachable, storedFlag, useFlagEnvironment } from '@/lib/feature-flags/feature-flags-test-support';
import type { EffectiveFeatureFlagsDto } from '@/lib/types/feature-flags';
import { GET } from './route';

/** Spec 041 §3.6 F3 — client-readable flags only, the same for guests and signed-in users, `no-store`. */
const dbReachable = await isDatabaseReachable();
const URL_ = 'http://localhost/api/v1/feature-flags/effective';
const CLIENT_KEYS = FEATURE_FLAG_REGISTRY.filter((f) => f.clientReadable).map((f) => f.key);

describe.skipIf(!dbReachable)('GET /api/v1/feature-flags/effective (spec 041 F3)', { timeout: 60_000 }, () => {
  useFlagEnvironment('staging');
  beforeEach(() => resetRateLimitState());

  it('a guest gets exactly the client-readable flags with their stored values, uncached', async () => {
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { data: EffectiveFeatureFlagsDto };
    expect(Object.keys(body.data.flags)).toEqual(CLIENT_KEYS);
    expect(body.data.flags['onboarding-intro-v1']).toBe((await storedFlag('onboarding-intro-v1', 'staging')).enabled);
  });

  it('never returns a developer flag or any non-client flag, and is identical for a signed-in user', async () => {
    const guest = (await (await GET(new Request(URL_))).json()) as { data: EffectiveFeatureFlagsDto };
    const user = await registerAndLogin();
    const signedIn = (await (await GET(authenticatedRequest(URL_, user.sessionId, user.csrfToken, { method: 'GET' }))).json()) as {
      data: EffectiveFeatureFlagsDto;
    };
    expect(signedIn.data).toEqual(guest.data);
    for (const flag of FEATURE_FLAG_REGISTRY.filter((f) => !f.clientReadable)) expect(signedIn.data.flags).not.toHaveProperty(flag.key);
  });

  it('is rate-limited per caller (429)', async () => {
    const user = await registerAndLogin();
    for (let i = 0; i < 100; i += 1) checkRateLimit('default', user.userId);
    expect((await GET(authenticatedRequest(URL_, user.sessionId, user.csrfToken, { method: 'GET' }))).status).toBe(429);
  });
});
