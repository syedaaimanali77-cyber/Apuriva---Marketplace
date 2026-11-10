/**
 * Spec 025 §4 "Retention and privacy" (AC-4) — the daily retention sweep.
 *
 *  1. Stamp `archived_at` on every conversation whose booking has reached an archived status but which no
 *     participant request has observed yet. `archived_at` is a cache of the booking-status derivation, and
 *     the sweep is an observer like any request — without this step an unopened archived conversation
 *     would never start its retention clock.
 *  2. For up to `RETENTION_SWEEP_BATCH` archived conversations past the window with
 *     `retention_applied_at IS NULL`, in ONE transaction: replace every body with the redaction sentinel,
 *     set `redacted_by_retention`, and stamp `retention_applied_at`.
 *
 * Anonymize, never delete. Idempotent: `retention_applied_at IS NULL` is the guard and `SKIP LOCKED`
 * keeps overlapping runs from contending, so a double run, an overlap or a retry does nothing twice. An
 * active conversation is never selected — the booking status is re-checked in the same statement.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { REDACTED_DESCRIPTION } from '@/lib/privacy/deletion';
import { archivedStatusesSql } from './conversations';
import { RETENTION_SWEEP_BATCH } from './limits';
import { getMessageRetentionDays } from './retention-config';

export interface MessageRetentionSweepResult {
  archivedStamped: number;
  conversationsSwept: number;
  messagesRedacted: number;
  windowDays: number;
}

export async function runMessageRetentionSweep(): Promise<MessageRetentionSweepResult> {
  const windowDays = getMessageRetentionDays();
  const db = getDb();

  const stamped = await queryRows<{ id: string }>(
    db,
    sql`UPDATE conversations c
           SET archived_at = clock_timestamp(), updated_at = clock_timestamp(), version = c.version + 1
          FROM bookings b
         WHERE b.id = c.booking_id AND c.archived_at IS NULL AND b.status IN (${archivedStatusesSql()})
     RETURNING c.id`,
  );

  const { conversationsSwept, messagesRedacted } = await db.transaction(async (tx) => {
    const due = await queryRows<{ id: string }>(
      tx,
      sql`SELECT c.id FROM conversations c
            JOIN bookings b ON b.id = c.booking_id
           WHERE c.retention_applied_at IS NULL
             AND c.archived_at IS NOT NULL
             AND c.archived_at < clock_timestamp() - make_interval(days => ${windowDays})
             AND b.status IN (${archivedStatusesSql()})
           ORDER BY c.archived_at ASC, c.id ASC
           LIMIT ${RETENTION_SWEEP_BATCH}
             FOR UPDATE OF c SKIP LOCKED`,
    );
    if (due.length === 0) return { conversationsSwept: 0, messagesRedacted: 0 };

    const ids = sql.join(due.map((row) => sql`${row.id}::uuid`), sql`, `);
    const redacted = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE messages
             SET body = ${REDACTED_DESCRIPTION}, redacted_by_retention = true,
                 updated_at = clock_timestamp(), version = version + 1
           WHERE conversation_id IN (${ids})
             AND (body <> ${REDACTED_DESCRIPTION} OR NOT redacted_by_retention)
       RETURNING id`,
    );
    await tx.execute(sql`
      UPDATE conversations
         SET retention_applied_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
       WHERE id IN (${ids})
    `);
    return { conversationsSwept: due.length, messagesRedacted: redacted.length };
  });

  const result = { archivedStamped: stamped.length, conversationsSwept, messagesRedacted, windowDays };
  console.log(JSON.stringify({ event: 'messaging.retention_swept', ...result }));
  return result;
}
