import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerCustomer } from '@/app/api/v1/providers/availability-test-support';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { databaseNameReader } from '@/lib/demo/guards';
import { capturedWrites, enterDemoEnvironment, isDatabaseReachable, isSessionRefresh } from '@/lib/demo/demo-test-support';
import { BASE, demoLoginRequest, loginAs } from './demo-route-test-support';
import { POST as LOGIN } from './login/route';
import { POST as RESET } from './reset/route';

const dbReachable = await isDatabaseReachable();

/** The writes a call made, minus spec 005's sliding refresh of the caller's own session (not domain data). */
async function writesOf(run: () => Promise<Response>): Promise<{ res: Response; writes: string[] }> {
  let res!: Response;
  const writes = await capturedWrites(async () => {
    res = await run();
  });
  return { res, writes: writes.filter((statement) => !isSessionRefresh(statement)) };
}

function resetRequest(sessionId: string, csrf: string | null, ip = '203.0.113.50'): Request {
  const req = authenticatedRequest(`${BASE}/demo/reset`, sessionId, csrf ?? '', { method: 'POST', body: {} });
  if (csrf === null) req.headers.delete('x-csrf-token');
  req.headers.set('x-forwarded-for', ip);
  return req;
}

describe.skipIf(!dbReachable)('spec 045 §3.6 / AC-7 — every refusal writes nothing', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = enterDemoEnvironment();
  });
  afterAll(() => restore?.());
  beforeEach(() => resetRateLimitState());
  afterEach(() => {
    process.env.APP_ENV = 'staging';
    process.env.DEMO_MODE_ENABLED = 'true';
  });

  it('APP_ENV=production → 403 DEMO_NOT_AVAILABLE_IN_PRODUCTION on both routes, even with the flag on', async () => {
    process.env.APP_ENV = 'production';
    const login = await writesOf(() => LOGIN(demoLoginRequest({ persona: 'customer' })));
    expect(login.res.status).toBe(403);
    expect(((await login.res.json()) as { code: string }).code).toBe('DEMO_NOT_AVAILABLE_IN_PRODUCTION');
    expect(login.writes).toEqual([]);
    const reset = await writesOf(() => RESET(new Request(`${BASE}/demo/reset`, { method: 'POST' })));
    expect(((await reset.res.json()) as { code: string }).code).toBe('DEMO_NOT_AVAILABLE_IN_PRODUCTION');
    expect(reset.writes).toEqual([]);
  });

  it('the demo-mode flag off → 403 DEMO_MODE_DISABLED', async () => {
    process.env.DEMO_MODE_ENABLED = 'false';
    const { res, writes } = await writesOf(() => LOGIN(demoLoginRequest({ persona: 'provider' })));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('DEMO_MODE_DISABLED');
    expect(writes).toEqual([]);
  });

  it('a database whose name does not end in _demo → 403 DEMO_MODE_DISABLED, and logs demo.misconfigured', async () => {
    const spy = vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva_staging');
    const log = vi.spyOn(console, 'log');
    try {
      const { res, writes } = await writesOf(() => LOGIN(demoLoginRequest({ persona: 'customer' })));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('DEMO_MODE_DISABLED');
      expect(log.mock.calls.some(([line]) => String(line).includes('"event":"demo.misconfigured"'))).toBe(true);
      expect(writes).toEqual([]);
    } finally {
      spy.mockReturnValue('apuriva_demo');
      log.mockRestore();
    }
  });

  it('D2 without a session → 401 UNAUTHENTICATED', async () => {
    const { res, writes } = await writesOf(() => RESET(new Request(`${BASE}/demo/reset`, { method: 'POST' })));
    expect(res.status).toBe(401);
    expect(writes).toEqual([]);
  });

  it('D2 by a non-demo user → 403 FORBIDDEN; nothing is provisioned and the session stays valid', async () => {
    const customer = await registerCustomer();
    resetRateLimitState();
    const { res, writes } = await writesOf(() => RESET(resetRequest(customer.sessionId, customer.csrfToken)));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect(writes).toEqual([]);
  });

  it('D2 without the CSRF header → 403 CSRF_TOKEN_INVALID', async () => {
    const visitor = await loginAs('customer', '203.0.113.60');
    resetRateLimitState();
    const { res, writes } = await writesOf(() => RESET(resetRequest(visitor.sessionId, null)));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('CSRF_TOKEN_INVALID');
    expect(writes).toEqual([]);
  }, 60_000);

  it('an exhausted auth bucket → 429 RATE_LIMITED, before any provisioning', async () => {
    const req = demoLoginRequest({ persona: 'customer' }, '203.0.113.70');
    const key = `demo-login:ip:${hashRequestIp(req) ?? 'unknown'}`;
    for (let i = 0; i < 10; i += 1) checkRateLimit('auth', key);
    const { res, writes } = await writesOf(() => LOGIN(req));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(writes).toEqual([]);
  });

  it('the write recorder does see a successful login’s writes (so an empty list above means nothing was written)', async () => {
    const { res, writes } = await writesOf(() => LOGIN(demoLoginRequest({ persona: 'customer' }, '203.0.113.71')));
    expect(res.status).toBe(200);
    expect(writes.some((statement) => /insert into users/i.test(statement))).toBe(true);
  }, 60_000);
});
