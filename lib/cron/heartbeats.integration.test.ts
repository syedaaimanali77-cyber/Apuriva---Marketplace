import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cronJobHeartbeats } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/app/api/v1/auth/test-support';
import { GET as sampleCron } from '@/app/api/v1/cron/sample/route';
import { readCronHeartbeats, recordCronFailure, recordCronStart, recordCronSuccess } from './heartbeats';

/** Spec 046 §3.8, §4 — the heartbeat table on the isolated `*_test` database. */
const dbReachable = await isDatabaseReachable();
const originalSecret = process.env.CRON_SECRET;

async function row(job: string) {
  const [r] = await getDb().select().from(cronJobHeartbeats).where(eq(cronJobHeartbeats.job, job));
  return r;
}

describe.skipIf(!dbReachable)('cron_job_heartbeats (spec 046 AC-5)', () => {
  const job = 'fraud-signal-sweep';

  beforeEach(async () => {
    await getDb().delete(cronJobHeartbeats).where(eq(cronJobHeartbeats.job, job));
    process.env.CRON_SECRET = 'heartbeat-test-secret';
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it('migration 0038 is journaled, and its down file drops exactly the table and index', () => {
    const journal = JSON.parse(readFileSync(path.resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0038_add_cron_job_heartbeats')?.idx).toBe(38);
    const down = readFileSync(path.resolve(__dirname, '../../drizzle/0038_add_cron_job_heartbeats_down.sql'), 'utf8');
    expect(down).toMatch(/DROP TABLE IF EXISTS "cron_job_heartbeats"/);
    expect(down).toMatch(/DROP INDEX IF EXISTS "cron_job_heartbeats_job_uq"/);
  });

  it('creates the row on first write, then upserts it: success resets failures, failures accumulate', async () => {
    await recordCronStart(job, new Date('2026-09-01T00:00:00Z'));
    expect(await row(job)).toMatchObject({ consecutiveFailures: 0, lastSucceededAt: null });

    await recordCronFailure(job, 'http_503', new Date('2026-09-01T00:01:00Z'));
    await recordCronFailure(job, 'exception', new Date('2026-09-01T00:02:00Z'));
    expect(await row(job)).toMatchObject({ consecutiveFailures: 2, lastErrorCode: 'exception' });

    await recordCronSuccess(job, new Date('2026-09-01T00:03:00Z'));
    const r = await row(job);
    expect(r).toMatchObject({ consecutiveFailures: 0, lastErrorCode: null });
    expect(r!.lastSucceededAt?.toISOString()).toBe('2026-09-01T00:03:00.000Z');
    expect(r!.lastFailedAt?.toISOString()).toBe('2026-09-01T00:02:00.000Z');
    expect(r!.version).toBeGreaterThanOrEqual(4);
  });

  it('stays one row under duplicate/concurrent delivery, counting every failure', async () => {
    await Promise.all(Array.from({ length: 5 }, () => recordCronFailure(job, 'http_500')));
    const rows = await getDb().select().from(cronJobHeartbeats).where(eq(cronJobHeartbeats.job, job));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consecutiveFailures).toBe(5);
  });

  it('truncates an over-long error code to the 64-character CHECK', async () => {
    await recordCronFailure(job, 'x'.repeat(200));
    expect((await row(job))!.lastErrorCode).toHaveLength(64);
  });

  it('enforces the CHECKs at the database', async () => {
    await expect(getDb().insert(cronJobHeartbeats).values({ job: 'Not A Job!' })).rejects.toThrow();
    await expect(
      getDb().execute(sql`INSERT INTO cron_job_heartbeats (job, consecutive_failures) VALUES ('negative-check', -1)`),
    ).rejects.toThrow();
  });

  it('a real cron route (sample) records its heartbeat through withCronRoute', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await getDb().delete(cronJobHeartbeats).where(eq(cronJobHeartbeats.job, 'sample'));

    const res = await sampleCron(
      new NextRequest('http://localhost/api/v1/cron/sample', { headers: { authorization: 'Bearer heartbeat-test-secret' } }),
    );

    expect(res.status).toBe(200);
    const r = await row('sample');
    expect(r?.lastStartedAt).toBeInstanceOf(Date);
    expect(r?.lastSucceededAt).toBeInstanceOf(Date);
    expect((await readCronHeartbeats()).some((h) => h.job === 'sample')).toBe(true);
  });
});
