/**
 * Spec 046 §3.8 — the `cron_job_heartbeats` writes and read. Every write is a single upsert on the
 * unique `job`, so it is safe under Vercel Cron's duplicate or concurrent delivery: the row only
 * ever records the latest start, success or failure, and `consecutive_failures` is incremented or
 * reset atomically in SQL, never read-modify-written in application code.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { cronJobHeartbeats } from '@/lib/db/schema';

export type CronHeartbeatRow = typeof cronJobHeartbeats.$inferSelect;

export async function recordCronStart(job: string, now: Date = new Date()): Promise<void> {
  await getDb()
    .insert(cronJobHeartbeats)
    .values({ job, lastStartedAt: now })
    .onConflictDoUpdate({
      target: cronJobHeartbeats.job,
      set: { lastStartedAt: now, updatedAt: now, version: sql`${cronJobHeartbeats.version} + 1` },
    });
}

export async function recordCronSuccess(job: string, now: Date = new Date()): Promise<void> {
  await getDb()
    .insert(cronJobHeartbeats)
    .values({ job, lastSucceededAt: now, consecutiveFailures: 0 })
    .onConflictDoUpdate({
      target: cronJobHeartbeats.job,
      set: {
        lastSucceededAt: now,
        lastErrorCode: null,
        consecutiveFailures: 0,
        updatedAt: now,
        version: sql`${cronJobHeartbeats.version} + 1`,
      },
    });
}

export async function recordCronFailure(job: string, errorCode: string, now: Date = new Date()): Promise<void> {
  const code = errorCode.slice(0, 64);
  await getDb()
    .insert(cronJobHeartbeats)
    .values({ job, lastFailedAt: now, lastErrorCode: code, consecutiveFailures: 1 })
    .onConflictDoUpdate({
      target: cronJobHeartbeats.job,
      set: {
        lastFailedAt: now,
        lastErrorCode: code,
        consecutiveFailures: sql`${cronJobHeartbeats.consecutiveFailures} + 1`,
        updatedAt: now,
        version: sql`${cronJobHeartbeats.version} + 1`,
      },
    });
}

export async function readCronHeartbeats(): Promise<CronHeartbeatRow[]> {
  return getDb().select().from(cronJobHeartbeats);
}
