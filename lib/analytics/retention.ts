/**
 * Spec 040 §4 "Retention and privacy" — the only code that deletes or de-attributes analytics events.
 *
 * Raw events are kept for `ANALYTICS_EVENT_RETENTION_DAYS` (default 90, spec 033's
 * `AI_USAGE_RETENTION_DAYS` precedent). Each run also clears `actor_user_id` on events whose user
 * spec 008 has anonymized (`lifecycle_status = 'deleted'`), so no event stays attributable to a
 * closed account. Batched; the next daily run continues.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';

export const DEFAULT_ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_RETENTION_BATCH_LIMIT = 500;

/** A positive integer, else the 90-day default. */
export function analyticsRetentionDays(): number {
  const raw = process.env.ANALYTICS_EVENT_RETENTION_DAYS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYTICS_RETENTION_DAYS;
}

export async function sweepAnalyticsRetention(
  now: Date = new Date(),
  db: Executor = getDb(),
): Promise<{ deleted: number; deattributed: number }> {
  const cutoff = new Date(now.getTime() - analyticsRetentionDays() * 86_400_000);
  const deleted = await queryRows<{ id: string }>(
    db,
    sql`DELETE FROM analytics_events
         WHERE id IN (SELECT id FROM analytics_events WHERE occurred_at < ${cutoff}
                       ORDER BY occurred_at LIMIT ${ANALYTICS_RETENTION_BATCH_LIMIT})
     RETURNING id`,
  );
  const deattributed = await queryRows<{ id: string }>(
    db,
    sql`UPDATE analytics_events SET actor_user_id = NULL, updated_at = clock_timestamp(), version = version + 1
         WHERE id IN (SELECT e.id FROM analytics_events e JOIN users u ON u.id = e.actor_user_id
                       WHERE u.lifecycle_status = 'deleted' LIMIT ${ANALYTICS_RETENTION_BATCH_LIMIT})
     RETURNING id`,
  );
  return { deleted: deleted.length, deattributed: deattributed.length };
}
