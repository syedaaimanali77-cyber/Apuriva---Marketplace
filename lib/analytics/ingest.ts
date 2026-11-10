/**
 * Spec 040 §3.3 (AC-1, AC-5) — best-effort, NON-BLOCKING event ingestion without a queue.
 *
 * Spec 001 §8 rules out a queue or worker, so events go into a module-level buffer, BOUNDED at
 * `MAX_PENDING_ANALYTICS_EVENTS`, and are flushed AFTER the response with Next.js `after()` (outside a
 * request scope — cron, scripts, tests — with `setTimeout(0)`).
 *
 * Delivery is AT MOST ONCE, BEST EFFORT (D-2):
 *   - a full buffer DROPS the new event and counts it;
 *   - a failed batch insert is DROPPED, never retried (a retry amplifies load exactly when the
 *     database is struggling), and logged;
 *   - `ANALYTICS_INGESTION_ENABLED=false` pauses ingestion.
 *
 * `recordAnalyticsEvent()` is synchronous, returns nothing and NEVER throws, so no tracked action can
 * be delayed, changed or failed by analytics.
 */
import { after } from 'next/server';
import { getDb } from '@/lib/db';
import { analyticsEvents } from '@/lib/db/schema';
import { validateAnalyticsEvent, type AnalyticsEventInput } from './events';

export const MAX_PENDING_ANALYTICS_EVENTS = 1000;
export const ANALYTICS_FLUSH_BATCH_SIZE = 200;

interface PendingEvent {
  eventType: AnalyticsEventInput['type'];
  actorUserId: string | null;
  properties: Record<string, unknown>;
  occurredAt: Date;
}

let pending: PendingEvent[] = [];
let droppedSinceLastReport = 0;
let flushing: Promise<void> | null = null;

/** Pausable without a deploy: only the literal `false` disables ingestion. */
export function isAnalyticsIngestionEnabled(): boolean {
  return process.env.ANALYTICS_INGESTION_ENABLED !== 'false';
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

/** Records one tracked action. Never throws, never awaits — see the module comment. */
export function recordAnalyticsEvent(input: AnalyticsEventInput): void {
  try {
    if (!isAnalyticsIngestionEnabled()) return;
    const problem = validateAnalyticsEvent(input);
    if (problem) {
      log('analytics.event_rejected', { eventType: String(input?.type), reason: problem });
      return;
    }
    if (pending.length >= MAX_PENDING_ANALYTICS_EVENTS) {
      droppedSinceLastReport += 1;
      scheduleFlush();
      return;
    }
    pending.push({ eventType: input.type, actorUserId: input.actorUserId, properties: { ...input.properties }, occurredAt: new Date() });
    scheduleFlush();
  } catch (err) {
    // Last line of defence: analytics must never surface an error to a tracked action.
    try {
      log('analytics.record_failed', { error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* nothing more can be done */
    }
  }
}

function scheduleFlush(): void {
  if (flushing) return;
  flushing = new Promise<void>((resolve) => {
    const run = () => {
      flushPending()
        .catch(() => undefined)
        .finally(() => {
          flushing = null;
          resolve();
          // Events recorded while this flush ran get their own.
          if (pending.length > 0 || droppedSinceLastReport > 0) scheduleFlush();
        });
    };
    try {
      // Inside a request: run after the response is sent; the platform keeps the instance alive.
      after(run);
    } catch {
      // Outside a request scope `after()` throws — fall back to the next macrotask.
      setTimeout(run, 0);
    }
  });
}

async function flushPending(): Promise<void> {
  if (droppedSinceLastReport > 0) {
    log('analytics.events_dropped', { count: droppedSinceLastReport, bound: MAX_PENDING_ANALYTICS_EVENTS });
    droppedSinceLastReport = 0;
  }
  while (pending.length > 0) {
    const batch = pending.splice(0, ANALYTICS_FLUSH_BATCH_SIZE);
    try {
      await getDb().insert(analyticsEvents).values(batch);
    } catch (err) {
      log('analytics.flush_failed', { dropped: batch.length, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Test-only: waits until everything recorded so far has been flushed (or dropped). */
export async function drainAnalyticsForTests(): Promise<void> {
  while (flushing) await flushing;
}

/** Test-only: the current buffer depth and unreported drop count. */
export function analyticsBufferStateForTests(): { pending: number; dropped: number } {
  return { pending: pending.length, dropped: droppedSinceLastReport };
}

/** Test-only: empties the buffer and counters (a scheduled flush then finds nothing). */
export function resetAnalyticsForTests(): void {
  pending = [];
  droppedSinceLastReport = 0;
}
