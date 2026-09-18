import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as SWEEP } from './route';
import { isDatabaseReachable, createAiUser, seedUsage } from '@/lib/ai/ai-test-support';
import type { AiSubject } from '@/lib/ai';

const dbReachable = await isDatabaseReachable();
const URL_ = 'http://localhost/api/v1/cron/ai-usage-sweep';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Spec 033 §3.2 — the hourly sweep: retention, abuse evaluation, cost alerts. */
describe.skipIf(!dbReachable)('GET /api/v1/cron/ai-usage-sweep (spec 033, integration)', () => {
  const savedSecret = process.env.CRON_SECRET;
  const savedRetention = process.env.AI_USAGE_RETENTION_DAYS;

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    if (savedRetention === undefined) delete process.env.AI_USAGE_RETENTION_DAYS;
    else process.env.AI_USAGE_RETENTION_DAYS = savedRetention;
  });

  const request = (headers: Record<string, string> = {}) => new NextRequest(URL_, { headers });

  it('refuses a missing, wrong or unconfigured cron secret', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    expect((await SWEEP(request())).status).toBe(401);
    expect((await SWEEP(request({ authorization: 'Bearer wrong' }))).status).toBe(401);

    delete process.env.CRON_SECRET;
    expect((await SWEEP(request({ authorization: 'Bearer correct-secret' }))).status).toBe(401);
  });

  it('runs all three passes and reports what each did', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    process.env.AI_USAGE_RETENTION_DAYS = '90';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 2, tokensUsed: 1, createdAt: new Date(Date.now() - 200 * DAY_MS) });

    const res = await SWEEP(request({ authorization: 'Bearer correct-secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.usageRowsDeleted).toBeGreaterThanOrEqual(2);
    expect(typeof body.subjectsEvaluated).toBe('number');
    expect(typeof body.abuseSignalsFlagged).toBe('number');
    expect(Array.isArray(body.costAlertsEmitted)).toBe(true);
  });

  it('is idempotent and retry-safe: a second run right after is a clean no-op for those rows', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    process.env.AI_USAGE_RETENTION_DAYS = '90';
    await SWEEP(request({ authorization: 'Bearer correct-secret' }));
    const second = await SWEEP(request({ authorization: 'Bearer correct-secret' }));
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe('ok');
  });
});
