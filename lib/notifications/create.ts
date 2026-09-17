/**
 * Spec 026 §3 "What a producing spec must supply" — `notify(event)`, the ONE entry point (AC-1–AC-5, AC-7).
 *
 * Server-internal only: no route reaches this (AC-9). In ONE transaction it
 *   1. returns the existing row if this (recipient, event_key) was already handed over (AC-7) — before
 *      the marketing cap, so a retried promotion is never suppressed by its own earlier send;
 *   2. for `promotions`, serializes per recipient (advisory lock) and requires consent AND an enabled
 *      `promotions` channel AND room under the cap — failing any: NO row, NO delivery, a recorded
 *      `notification.marketing_suppressed` (AC-3, AC-5);
 *   3. writes the notification row — the in-app channel, delivered the moment it commits (AC-1, AC-2);
 *   4. queues one `pending` delivery per resolved outbound channel (none for a disabled category).
 * `UNIQUE (recipient_user_id, event_key)` is the structural guarantee: a concurrent duplicate waits on
 * the first insert and then returns that row.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type {
  NotificationCategory,
  NotificationDto,
  NotificationEventInput,
  NotificationParams,
  NotificationType,
  OutboundChannel,
} from '@/lib/types/notifications';
import { renderNotification } from './catalogue';
import { marketingMaxPerWindow, marketingWindowDays } from './config';
import { loadStoredPreferences, promotionsAllowed, resolveOutboundChannels } from './preferences';
import { queryRows, type Executor } from './sql';

export type NotifyResult =
  | { status: 'created'; notification: NotificationDto; channels: OutboundChannel[] }
  | { status: 'duplicate'; notification: NotificationDto }
  | { status: 'suppressed'; reason: 'no_consent' | 'preference_disabled' | 'frequency_cap' };

export interface NotificationRow {
  id: string;
  category: string;
  type: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date;
}

export const NOTIFICATION_COLUMNS = sql`id, category, type, title, body, read_at, created_at`;

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    category: row.category as NotificationCategory,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function assertEvent(event: NotificationEventInput): void {
  if (typeof event.recipientUserId !== 'string' || event.recipientUserId.length === 0) {
    throw new TypeError('notify(): recipientUserId is required');
  }
  if (typeof event.eventKey !== 'string' || event.eventKey.trim().length === 0) {
    throw new TypeError('notify(): a deterministic eventKey is required');
  }
}

async function findExisting(db: Executor, recipientUserId: string, eventKey: string): Promise<NotificationRow | undefined> {
  const [row] = await queryRows<NotificationRow>(
    db,
    sql`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE recipient_user_id = ${recipientUserId} AND event_key = ${eventKey}`,
  );
  return row;
}

export async function notify(event: NotificationEventInput): Promise<NotifyResult> {
  assertEvent(event);
  const params: NotificationParams = event.params ?? {};
  // Throws for an unknown type or a missing declared param — a programming error in the producer.
  const rendered = renderNotification(event.type, params);
  const { category } = rendered;

  const result = await getDb().transaction(async (tx): Promise<NotifyResult> => {
    if (category === 'promotions') {
      // Serializes this recipient's promotional sends so two concurrent promotions cannot both pass the cap.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notifications.promotions:${event.recipientUserId}`}))`);
    }

    const existing = await findExisting(tx, event.recipientUserId, event.eventKey);
    if (existing) return { status: 'duplicate', notification: toNotificationDto(existing) };

    const prefs = await loadStoredPreferences(tx, event.recipientUserId);

    if (category === 'promotions') {
      const gate = promotionsAllowed(prefs);
      if (!gate.allowed) return { status: 'suppressed', reason: gate.reason };
      // Counted per NOTIFICATION, not per channel; transactional categories never count (AC-5).
      const [{ sent }] = await queryRows<{ sent: number }>(
        tx,
        sql`SELECT count(*)::int AS sent FROM notifications
             WHERE recipient_user_id = ${event.recipientUserId} AND category = 'promotions'
               AND created_at > clock_timestamp() - make_interval(days => ${marketingWindowDays()})`,
      );
      if (sent >= marketingMaxPerWindow()) return { status: 'suppressed', reason: 'frequency_cap' };
    }

    const inserted = await queryRows<NotificationRow>(
      tx,
      sql`INSERT INTO notifications (recipient_user_id, category, type, title, body, params, event_key)
          VALUES (${event.recipientUserId}, ${category}, ${event.type}, ${rendered.title}, ${rendered.body},
                  ${JSON.stringify(params)}::jsonb, ${event.eventKey})
          ON CONFLICT (recipient_user_id, event_key) DO NOTHING
          RETURNING ${NOTIFICATION_COLUMNS}`,
    );
    if (inserted.length === 0) {
      // Lost a race to a concurrent handover of the same event: the unique index admitted exactly one.
      const raced = await findExisting(tx, event.recipientUserId, event.eventKey);
      if (!raced) throw new Error('notify(): unique conflict without a visible row');
      return { status: 'duplicate', notification: toNotificationDto(raced) };
    }
    const row = inserted[0]!;

    const channels = resolveOutboundChannels(category, prefs?.categories ?? null);
    for (const channel of channels) {
      await tx.execute(sql`
        INSERT INTO notification_deliveries (notification_id, channel, status, next_attempt_at)
        VALUES (${row.id}, ${channel}, 'pending', clock_timestamp())
        ON CONFLICT (notification_id, channel) DO NOTHING
      `);
    }
    return { status: 'created', notification: toNotificationDto(row), channels };
  });

  if (result.status === 'created') {
    console.log(
      JSON.stringify({
        event: 'notification.created',
        notificationId: result.notification.id,
        category,
        type: event.type,
        channels: ['in_app', ...result.channels],
      }),
    );
  } else if (result.status === 'suppressed') {
    console.log(
      JSON.stringify({
        event: 'notification.marketing_suppressed',
        recipientUserId: event.recipientUserId,
        category,
        type: event.type,
        reason: result.reason,
      }),
    );
  }
  return result;
}
