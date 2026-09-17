/**
 * Spec 026 §4 "Retention and privacy" — export, deletion redaction and retention for this spec's rows.
 *
 * Export carries the user's OWN record of what they were told, plus their preferences and the consent
 * instant. NEVER exported: `event_key`, `params`, and every `notification_deliveries` column — internal
 * routing and diagnostics, not the user's record.
 *
 * Deletion redacts `title`/`body`/`params` (they can quote the user's own booking detail) but keeps the row,
 * its category and timestamps as the record that a required notice was sent. `marketing_consent_at`/`_source`
 * are RETAINED: the evidence that consent was held must survive the account.
 *
 * Retention deletes READ notifications older than `NOTIFICATION_RETENTION_DAYS`; unread ones never. Both
 * run from spec 008's existing `sweepDeletions` (the `/cron/account-deletion-sweep` route) — no new sweep.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { CategoryChannelMap, NotificationDto } from '@/lib/types/notifications';
import { RETENTION_SWEEP_BATCH_LIMIT, notificationRetentionDays } from './config';
import { NOTIFICATION_COLUMNS, toNotificationDto, type NotificationRow } from './create';
import { loadStoredPreferences } from './preferences';
import { queryRows, type Executor } from './sql';

export interface ExportedNotificationData {
  notifications: NotificationDto[];
  preferences: { categories: CategoryChannelMap; marketingConsentAt: string | null } | null;
}

export async function exportNotificationData(userId: string): Promise<ExportedNotificationData> {
  const db = getDb();
  const rows = await queryRows<NotificationRow>(
    db,
    sql`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE recipient_user_id = ${userId} ORDER BY created_at DESC, id DESC`,
  );
  const prefs = await loadStoredPreferences(db, userId);
  return {
    notifications: rows.map(toNotificationDto),
    preferences: prefs
      ? { categories: prefs.categories, marketingConsentAt: prefs.marketingConsentAt ? prefs.marketingConsentAt.toISOString() : null }
      : null,
  };
}

/** The placeholder a redacted notification carries — spec 008's platform sentinel, passed in by the caller. */
export async function redactNotificationsForDeletedUser(db: Executor, userId: string, sentinel: string): Promise<void> {
  await db.execute(sql`
    UPDATE notifications
       SET title = ${sentinel}, body = ${sentinel}, params = '{}'::jsonb, updated_at = clock_timestamp(), version = version + 1
     WHERE recipient_user_id = ${userId} AND (title <> ${sentinel} OR body <> ${sentinel} OR params <> '{}'::jsonb)
  `);
  // A closed account is never contacted again: anything still queued is recorded as not sent.
  await db.execute(sql`
    UPDATE notification_deliveries
       SET status = 'skipped', skip_reason = 'account_deleted', next_attempt_at = NULL,
           updated_at = clock_timestamp(), version = version + 1
     WHERE status IN ('pending','retrying')
       AND notification_id IN (SELECT id FROM notifications WHERE recipient_user_id = ${userId})
  `);
}

export async function sweepNotificationRetention(): Promise<{ deleted: number; windowDays: number }> {
  const windowDays = notificationRetentionDays();
  const deleted = await getDb().transaction(async (tx) => {
    const due = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM notifications
           WHERE read_at IS NOT NULL AND read_at < clock_timestamp() - make_interval(days => ${windowDays})
           ORDER BY read_at ASC, id ASC
           LIMIT ${RETENTION_SWEEP_BATCH_LIMIT}
             FOR UPDATE SKIP LOCKED`,
    );
    if (due.length === 0) return 0;
    const ids = sql.join(due.map((row) => sql`${row.id}::uuid`), sql`, `);
    // Delivery rows are diagnostics of a notification that no longer exists; the FK is RESTRICT.
    await tx.execute(sql`DELETE FROM notification_deliveries WHERE notification_id IN (${ids})`);
    const removed = await queryRows<{ id: string }>(tx, sql`DELETE FROM notifications WHERE id IN (${ids}) RETURNING id`);
    return removed.length;
  });
  if (deleted > 0) console.log(JSON.stringify({ event: 'notification.retention_swept', deleted, windowDays }));
  return { deleted, windowDays };
}
