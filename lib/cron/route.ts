/**
 * Spec 046 §3.2 (AC-4, AC-5) — the one wrapper every `app/api/v1/cron/*` route handler runs in.
 *
 * Vercel Cron calls each route with `Authorization: Bearer $CRON_SECRET`, best-effort, never retries a
 * failed run, and may deliver the same run twice. The sweeps themselves are already claim-based and
 * idempotent; this wrapper adds only what was missing around them:
 *
 *   1. the existing bearer check (same 401 body as before), now compared in constant time;
 *   2. a correlation ID, with the handler run inside spec 039's request context, so audit rows and
 *      `logEvent` lines written by the sweep carry it;
 *   3. the `cron_job_heartbeats` start / success / failure record that `/health/detailed` and the
 *      ops-health-check monitor use to spot a failing or silent sweep;
 *   4. one `cron.run` line per authorized invocation.
 *
 * The handler body is untouched and its response is returned as-is. A heartbeat write that fails
 * (for example the database is down) is logged, never allowed to change the sweep's own outcome.
 * An exception from the handler is recorded, logged and re-thrown, so Next answers 500 as before.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { logEvent } from '@/lib/observability/log';
import { recordCronFailure, recordCronStart, recordCronSuccess } from './heartbeats';
import { cronSchedule } from './schedules';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Constant-time `Authorization: Bearer $CRON_SECRET` check. An unset secret authorizes nothing. */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

async function safely(job: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    logEvent('warn', 'cron.heartbeat_write_failed', { job, error: err instanceof Error ? err.name : 'unknown' });
  }
}

/** Top-level numeric fields of a JSON response body (the handler's own counts), else `{}`. */
async function responseCounts(res: Response): Promise<Record<string, number>> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return {};
  try {
    const body: unknown = await res.clone().json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
    return Object.fromEntries(Object.entries(body).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

export function withCronRoute<R extends Request>(
  job: string,
  handler: (request: R) => Promise<Response>,
): (request: R) => Promise<Response> {
  if (!cronSchedule(job)) {
    throw new Error(`withCronRoute: "${job}" is not a job in vercel.json (lib/cron/schedules.ts)`);
  }

  return async (request: R) => {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
    }

    const correlationId = randomUUID();
    return runWithRequestContext({ correlationId }, async () => {
      const startedAt = Date.now();
      await safely(job, () => recordCronStart(job));

      let res: Response;
      try {
        res = await handler(request);
      } catch (err) {
        await safely(job, () => recordCronFailure(job, 'exception'));
        logEvent('error', 'cron.run', {
          job,
          status: 'error',
          httpStatus: 500,
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.name : 'unknown',
        });
        throw err;
      }

      const ok = res.status >= 200 && res.status < 300;
      await safely(job, () => (ok ? recordCronSuccess(job) : recordCronFailure(job, `http_${res.status}`)));
      logEvent(ok ? 'info' : 'error', 'cron.run', {
        job,
        status: ok ? 'ok' : 'error',
        httpStatus: res.status,
        durationMs: Date.now() - startedAt,
        counts: await responseCounts(res),
      });
      res.headers.set('x-correlation-id', correlationId);
      return res;
    });
  };
}
