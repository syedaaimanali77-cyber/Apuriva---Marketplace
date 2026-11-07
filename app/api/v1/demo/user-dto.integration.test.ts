import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerCustomer } from '@/app/api/v1/providers/availability-test-support';
import { enterDemoEnvironment, isDatabaseReachable } from '@/lib/demo/demo-test-support';
import { GET as ME } from '@/app/api/v1/users/me/route';
import { PATCH as SWITCH_MODE } from '@/app/api/v1/users/me/active-mode/route';
import { BASE, loginAs } from './demo-route-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 045 X-7 — `UserDto.isDemo` comes from BOTH routes that build the DTO, so the account page (whose client
 * copy a mode switch replaces with the PATCH response) keeps offering "Reset demo" after a switch.
 */
describe.skipIf(!dbReachable)('UserDto.isDemo (spec 045 X-7)', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = enterDemoEnvironment();
  });
  afterAll(() => restore?.());
  beforeEach(() => resetRateLimitState());

  it('is true for a demo persona on GET /users/me and on every PATCH /users/me/active-mode response', async () => {
    const visitor = await loginAs('provider', '203.0.113.140');
    const me = await ME(authenticatedRequest(`${BASE}/users/me`, visitor.sessionId, visitor.csrfToken));
    expect(((await me.json()) as { data: { isDemo: boolean } }).data.isDemo).toBe(true);

    for (const mode of ['provider', 'customer'] as const) {
      const res = await SWITCH_MODE(authenticatedRequest(`${BASE}/users/me/active-mode`, visitor.sessionId, visitor.csrfToken, { method: 'PATCH', body: { mode } }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { activeMode: string; isDemo: boolean } }).data).toMatchObject({ activeMode: mode, isDemo: true });
    }
  }, 60_000);

  it('is false for an ordinary account on both routes', async () => {
    const customer = await registerCustomer();
    const me = await ME(authenticatedRequest(`${BASE}/users/me`, customer.sessionId, customer.csrfToken));
    expect(((await me.json()) as { data: { isDemo: boolean } }).data.isDemo).toBe(false);
    const res = await SWITCH_MODE(authenticatedRequest(`${BASE}/users/me/active-mode`, customer.sessionId, customer.csrfToken, { method: 'PATCH', body: { mode: 'customer' } }));
    expect(((await res.json()) as { data: { isDemo: boolean } }).data.isDemo).toBe(false);
  });
});
