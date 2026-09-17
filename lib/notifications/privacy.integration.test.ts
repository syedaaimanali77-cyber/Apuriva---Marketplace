import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { generateExportPayload } from '@/lib/privacy/export';
import { REDACTED_DESCRIPTION, sweepDeletions } from '@/lib/privacy/deletion';
import { notify } from './create';
import { setMarketingConsent } from './preferences';
import { sweepNotificationRetention } from './privacy';
import { createUser, deliveriesFor, isDatabaseReachable, setPreferences } from './notifications-test-support';
import { queryRows } from './sql';

const dbReachable = await isDatabaseReachable();

async function created(userId: string, eventKey: string): Promise<string> {
  const result = await notify({
    recipientUserId: userId,
    type: 'booking_cancelled',
    eventKey,
    params: { bookingId: 'b-1', refundAmount: 'PKR 500.00', feeAmount: 'PKR 0.00' },
  });
  if (result.status !== 'created') throw new Error('expected created');
  return result.notification.id;
}

/** Spec 026 §4 "Retention and privacy" — spec 008 export/deletion, and read-notification retention. */
describe.skipIf(!dbReachable)('notification privacy (spec 026 §4, integration)', () => {
  it('export carries notifications, preferences and the consent instant, and no event_key, params or delivery column', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true } });
    await setMarketingConsent(userId, { consent: true });
    const id = await created(userId, 'booking_cancelled:export');
    const other = await createUser();
    await created(other, 'booking_cancelled:export-other');

    const payload = await generateExportPayload(userId);
    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0]).toMatchObject({ id, category: 'booking', type: 'booking_cancelled', readAt: null });
    expect(Object.keys(payload.notifications[0]!).sort()).toEqual(['body', 'category', 'createdAt', 'id', 'readAt', 'title', 'type']);
    expect(payload.preferences).not.toBeNull();
    expect(payload.preferences!.categories.booking).toEqual({ email: true, push: false, sms: false });
    expect(payload.preferences!.marketingConsentAt).toEqual(expect.any(String));

    const serialized = JSON.stringify(payload);
    for (const internal of ['booking_cancelled:export', 'eventKey', 'event_key', 'params', 'providerReference', 'skipReason', 'attempts']) {
      expect(serialized).not.toContain(internal);
    }
  });

  it('a user with no preference row exports null preferences and an empty notification list', async () => {
    const payload = await generateExportPayload(await createUser());
    expect(payload.preferences).toBeNull();
    expect(payload.notifications).toEqual([]);
  });

  it('deletion redacts title/body/params, keeps the row and category, skips queued deliveries, and retains the consent record', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true } });
    await setMarketingConsent(userId, { consent: true });
    const id = await created(userId, 'booking_cancelled:delete');
    await getDb().execute(sql`
      UPDATE users SET lifecycle_status = 'deletion_pending', deletion_grace_ends_at = clock_timestamp() - interval '1 day'
       WHERE id = ${userId}
    `);

    await sweepDeletions();

    const [row] = await queryRows<{ title: string; body: string; params: Record<string, unknown>; category: string; created_at: string }>(
      getDb(),
      sql`SELECT title, body, params, category, created_at FROM notifications WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ title: REDACTED_DESCRIPTION, body: REDACTED_DESCRIPTION, params: {}, category: 'booking' });
    expect(row!.created_at).toBeTruthy();
    expect((await deliveriesFor(id))[0]).toMatchObject({ status: 'skipped', skip_reason: 'account_deleted' });

    const [prefs] = await queryRows<{ marketing_consent_at: string | null; marketing_consent_source: string | null }>(
      getDb(),
      sql`SELECT marketing_consent_at, marketing_consent_source FROM notification_preferences WHERE user_id = ${userId}`,
    );
    expect(prefs!.marketing_consent_at).not.toBeNull();
    expect(prefs!.marketing_consent_source).toBe('account_settings');
  });

  it('retention deletes read rows past the window and never unread ones', async () => {
    const userId = await createUser();
    const oldRead = await created(userId, 'booking_cancelled:ret-old-read');
    const recentRead = await created(userId, 'booking_cancelled:ret-recent-read');
    const oldUnread = await created(userId, 'booking_cancelled:ret-old-unread');
    await getDb().execute(sql`UPDATE notifications SET read_at = clock_timestamp() - interval '181 days' WHERE id = ${oldRead}`);
    await getDb().execute(sql`UPDATE notifications SET read_at = clock_timestamp() - interval '10 days' WHERE id = ${recentRead}`);
    await getDb().execute(sql`UPDATE notifications SET created_at = clock_timestamp() - interval '400 days' WHERE id = ${oldUnread}`);
    // A delivery row on the old read notification must not block its removal (FK RESTRICT).
    await getDb().execute(sql`INSERT INTO notification_deliveries (notification_id, channel, status) VALUES (${oldRead}, 'push', 'failed')`);

    const result = await sweepNotificationRetention();
    expect(result.windowDays).toBe(180);
    // Not asserting `result.deleted`: any concurrently running suite's `sweepDeletions()` may remove it first.

    const remaining = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM notifications WHERE recipient_user_id = ${userId}`);
    expect(remaining.map((r) => r.id).sort()).toEqual([recentRead, oldUnread].sort());
    expect(await deliveriesFor(oldRead)).toEqual([]);
  });

  it('read_at is immutable once set, at the database', async () => {
    const userId = await createUser();
    const id = await created(userId, 'booking_cancelled:immutable');
    await getDb().execute(sql`UPDATE notifications SET read_at = clock_timestamp() WHERE id = ${id}`);
    await expect(getDb().execute(sql`UPDATE notifications SET read_at = NULL WHERE id = ${id}`)).rejects.toThrow();
    await expect(getDb().execute(sql`UPDATE notifications SET read_at = clock_timestamp() + interval '1 hour' WHERE id = ${id}`)).rejects.toThrow();
  });
});
