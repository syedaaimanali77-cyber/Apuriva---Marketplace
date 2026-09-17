/**
 * Spec 026 §3 "Endpoints" — the caller's own notification centre (AC-8, AC-9).
 *
 * Every statement is scoped `recipient_user_id = <caller>`: another user's id is simply not found, so it
 * is `404 NOTIFICATION_NOT_FOUND`, never `403`. Order is `created_at DESC, id DESC` — a TOTAL order, so
 * offset pagination can neither repeat nor skip a row — served by `notifications_recipient_created_idx`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { PageParams } from '@/lib/api/pagination';
import type { NotificationDto } from '@/lib/types/notifications';
import { NOTIFICATION_COLUMNS, toNotificationDto, type NotificationRow } from './create';
import { notificationNotFoundError } from './errors';
import { isUuid, queryRows } from './sql';

export async function listNotifications(
  userId: string,
  page: PageParams,
  options: { unreadOnly: boolean },
): Promise<{ items: NotificationDto[]; total: number }> {
  const db = getDb();
  const unread = options.unreadOnly ? sql`AND read_at IS NULL` : sql``;
  const [{ total }] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM notifications WHERE recipient_user_id = ${userId} ${unread}`,
  );
  const rows = await queryRows<NotificationRow>(
    db,
    sql`SELECT ${NOTIFICATION_COLUMNS} FROM notifications
         WHERE recipient_user_id = ${userId} ${unread}
         ORDER BY created_at DESC, id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  return { items: rows.map(toNotificationDto), total };
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const [{ unread }] = await queryRows<{ unread: number }>(
    getDb(),
    sql`SELECT count(*)::int AS unread FROM notifications WHERE recipient_user_id = ${userId} AND read_at IS NULL`,
  );
  return unread;
}

/** Idempotent: a second call returns `200` with the SAME `readAt` (the DB trigger forbids changing it). */
export async function markNotificationRead(userId: string, notificationId: string): Promise<NotificationDto> {
  if (!isUuid(notificationId)) throw notificationNotFoundError();
  const db = getDb();
  const updated = await queryRows<NotificationRow>(
    db,
    sql`UPDATE notifications
           SET read_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${notificationId} AND recipient_user_id = ${userId} AND read_at IS NULL
     RETURNING ${NOTIFICATION_COLUMNS}`,
  );
  if (updated[0]) return toNotificationDto(updated[0]);
  const [existing] = await queryRows<NotificationRow>(
    db,
    sql`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ${notificationId} AND recipient_user_id = ${userId}`,
  );
  if (!existing) throw notificationNotFoundError();
  return toNotificationDto(existing);
}

export async function markAllNotificationsRead(userId: string): Promise<{ updated: number }> {
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`UPDATE notifications
           SET read_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE recipient_user_id = ${userId} AND read_at IS NULL
     RETURNING id`,
  );
  return { updated: rows.length };
}
