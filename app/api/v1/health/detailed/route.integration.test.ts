import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cronJobHeartbeats } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { recordCronFailure, recordCronSuccess } from '@/lib/cron/heartbeats';
import { grantRole, isDatabaseReachable, registerAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { DetailedHealthDto } from '@/lib/types/ops';
import { GET } from './route';

/**
 * Spec 046 AC-8 — `GET /api/v1/health/detailed` against the isolated `*_test` database: who may read it,
 * and that it reflects real dependency state. The database-down → 503 path is covered deterministically
 * by `route.test.ts` and `lib/ops/health.test.ts` (this test does not break the shared test database).
 * Uses sweeps no other test file touches, so parallel files cannot race these rows.
 */
const dbReachable = await isDatabaseReachable();

const TOKEN = 't'.repeat(40);
const JOBS = { stale: 'support-reopen-sweep', failing: 'dispute-appeal-sweep', fresh: 'payout-reconcile-sweep' } as const;
const SAVED = ['MONITORING_TOKEN', 'APP_ENV', 'PAYMENT_PROVIDER', 'AI_ASSISTANT_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/health/detailed', { headers: { 'x-forwarded-for': '192.0.2.44', ...headers } });
}

async function read(res: Response): Promise<DetailedHealthDto> {
  return ((await res.json()) as { data: DetailedHealthDto }).data;
}

describe.skipIf(!dbReachable)('GET /api/v1/health/detailed (spec 046 AC-8)', () => {
  beforeEach(async () => {
    for (const key of SAVED) saved[key] = process.env[key];
    process.env.MONITORING_TOKEN = TOKEN;
    delete process.env.AI_ASSISTANT_ENABLED;
    resetRateLimitState();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await getDb().delete(cronJobHeartbeats).where(inArray(cronJobHeartbeats.job, Object.values(JOBS)));
  });

  afterEach(() => {
    for (const key of SAVED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  it('401 without credentials, with a wrong token, and while the configured token is too short', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({ authorization: `Bearer ${'x'.repeat(40)}` }))).status).toBe(401);
    process.env.MONITORING_TOKEN = 'short';
    expect((await GET(request({ authorization: 'Bearer short' }))).status).toBe(401);
  });

  it('reflects real dependency status with the monitoring token, and leaks no error text', async () => {
    await recordCronSuccess(JOBS.fresh);
    await recordCronSuccess(JOBS.stale, new Date(Date.now() - 4 * 60 * 60 * 1000)); // hourly job → stale after 3 h
    for (let i = 0; i < 3; i += 1) await recordCronFailure(JOBS.failing, 'http_503');

    const res = await GET(request({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const health = await read(res);
    const byName = Object.fromEntries(health.dependencies.map((d) => [d.name, d]));

    expect(byName.database).toMatchObject({ status: 'up' });
    expect(byName.migrations).toEqual({ name: 'migrations', status: 'up' });
    expect(byName[`cron:${JOBS.fresh}`]).toEqual({ name: `cron:${JOBS.fresh}`, status: 'up' });
    expect(byName[`cron:${JOBS.stale}`]).toMatchObject({ status: 'degraded', detail: 'stale' });
    expect(byName[`cron:${JOBS.failing}`]).toMatchObject({ status: 'degraded', detail: '3_consecutive_failures' });
    expect(byName['kill-switch:ai-assistant']).toEqual({ name: 'kill-switch:ai-assistant', status: 'up' });
    expect(health.status).toBe('degraded');
    expect(JSON.stringify(health)).not.toMatch(/Error|ECONN|postgres/i);
  });

  it('reports a kill switch turned off (spec 041) as degraded', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'false';
    const health = await read(await GET(request({ authorization: `Bearer ${TOKEN}` })));
    expect(health.dependencies.find((d) => d.name === 'kill-switch:ai-assistant')).toEqual({
      name: 'kill-switch:ai-assistant',
      status: 'degraded',
      detail: 'kill_switch_off',
    });
  });

  it('reports a sandbox adapter under APP_ENV=production', async () => {
    process.env.APP_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'sandbox';
    const health = await read(await GET(request({ authorization: `Bearer ${TOKEN}` })));
    expect(health.environment).toBe('production');
    expect(health.dependencies.find((d) => d.name === 'adapter:payments')).toEqual({
      name: 'adapter:payments',
      status: 'degraded',
      detail: 'sandbox_in_production',
    });
  });

  it('admits an MFA-complete Super Admin session, but not another admin role or an MFA-pending session', async () => {
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const cookie = (sessionId: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${sessionId}` });

    expect((await GET(request(cookie(superAdmin.sessionId)))).status).toBe(200);

    const pending = await createSession({ userId: superAdmin.userId, mfaSatisfied: false });
    expect((await GET(request(cookie(pending.id)))).status).toBe(401);

    const support = await registerAdmin();
    await grantRole(support, 'support_admin');
    expect((await GET(request(cookie(support.sessionId)))).status).toBe(401);
  });
});
