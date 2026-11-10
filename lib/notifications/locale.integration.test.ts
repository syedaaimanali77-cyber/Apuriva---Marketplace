import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { formatMoney } from '@/lib/i18n/format';
import { useUrduLocaleFlag } from '@/lib/i18n/i18n-test-support';
import { ur } from '@/lib/i18n/dictionaries/ur';
import type { OutboundChannel } from '@/lib/types/notifications';
import type { ChannelAdapterSet, ChannelDeliveryInput } from './channels';
import { notify, toReaderNotificationDto } from './create';
import { runNotificationDispatchSweep } from './dispatch';
import { listNotifications } from './inbox';
import { cancellationEventToNotification } from './sinks';
import { createUser, deliveriesFor, isDatabaseReachable, setPreferences } from './notifications-test-support';

const dbReachable = await isDatabaseReachable();
const PAGE = { limit: 20, offset: 0 };

async function notifyCancellation(userId: string, refund: number, fee: number, currencyCode: string): Promise<string> {
  const input = cancellationEventToNotification({
    kind: 'booking_cancelled',
    bookingId: randomUUID(),
    recipientUserId: userId,
    refundAmountMinorUnits: refund,
    feeAmountMinorUnits: fee,
    currencyCode,
  });
  const result = await notify(input);
  if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
  return result.notification.id;
}

/** Spec 042 §3.8 (X-6, D-5). */
describe.skipIf(!dbReachable)('notifications render per reader locale (spec 042 §3.8, integration)', () => {
  const { setUrduLocale } = useUrduLocaleFlag();

  it('producers pass TYPED money; the stored row keeps canonical English text and the typed params', async () => {
    const userId = await createUser();
    const id = await notifyCancellation(userId, 150_000, 25_000, 'PKR');
    const [row] = (
      await getDb().execute(sql`SELECT title, body, params FROM notifications WHERE id = ${id}`)
    ).rows as Array<{ title: string; body: string; params: Record<string, unknown> }>;
    expect(row!.params.refundAmount).toEqual({ amountMinorUnits: 150_000, currencyCode: 'PKR' });
    expect(row!.params.feeAmount).toEqual({ amountMinorUnits: 25_000, currencyCode: 'PKR' });
    expect(row!.title).toBe('Booking cancelled');
    expect(row!.body).toContain(formatMoney(150_000, 'PKR', 'en'));
  });

  it('the inbox re-renders one row for each reader locale, money formatted with the value\'s own currency', async () => {
    const userId = await createUser();
    await notifyCancellation(userId, 1_500, 0, 'JPY');

    const [english] = (await listNotifications(userId, PAGE, { unreadOnly: false, locale: 'en' })).items;
    expect(english!.title).toBe('Booking cancelled');
    expect(english!.body).toContain(formatMoney(1_500, 'JPY', 'en'));

    const [urdu] = (await listNotifications(userId, PAGE, { unreadOnly: false, locale: 'ur' })).items;
    expect(urdu!.title).toBe(ur.notifications.booking_cancelled.title);
    expect(urdu!.body).toContain(formatMoney(1_500, 'JPY', 'ur'));
    expect(urdu!.body).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('a historical row with plain-string params renders them exactly as stored', async () => {
    const userId = await createUser();
    await getDb().execute(sql`
      INSERT INTO notifications (recipient_user_id, category, type, event_key, title, body, params)
      VALUES (${userId}, 'booking', 'booking_cancelled', ${`legacy:${randomUUID()}`}, 'Booking cancelled',
              'A booking you are part of was cancelled. Refund: PKR 1,500.00. Cancellation fee: PKR 0.00.',
              ${JSON.stringify({ refundAmount: 'PKR 1,500.00', feeAmount: 'PKR 0.00' })}::jsonb)
    `);
    const [urdu] = (await listNotifications(userId, PAGE, { unreadOnly: false, locale: 'ur' })).items;
    expect(urdu!.title).toBe(ur.notifications.booking_cancelled.title);
    expect(urdu!.body).toContain('PKR 1,500.00');
    expect(urdu!.body).toContain('PKR 0.00');
  });

  it('a row whose type left the catalogue falls back to its stored title/body', () => {
    const row = {
      id: randomUUID(),
      category: 'operational',
      type: 'retired_type',
      title: 'Stored title',
      body: 'Stored body',
      params: {},
      read_at: null,
      created_at: new Date(),
    };
    expect(toReaderNotificationDto(row, 'ur')).toMatchObject({ title: 'Stored title', body: 'Stored body' });
    // An unrenderable stored params set (a declared param missing) also falls back rather than failing the read.
    expect(toReaderNotificationDto({ ...row, type: 'booking_cancelled', params: {} }, 'ur')).toMatchObject({ title: 'Stored title' });
  });

  it("channel dispatch renders in the recipient's saved locale while usable, else en", async () => {
    const userId = await createUser();
    await getDb().update(users).set({ locale: 'ur' }).where(eq(users.id, userId));
    await setPreferences(userId, { booking: { push: false, email: true, sms: false } });

    const sent: ChannelDeliveryInput[] = [];
    const capture = (channel: OutboundChannel) => ({
      channel,
      async deliver(input: ChannelDeliveryInput) {
        sent.push(input);
        return { outcome: 'delivered' as const, providerReference: `test_${randomUUID()}` };
      },
    });
    const adapters: ChannelAdapterSet = { push: capture('push'), email: capture('email'), sms: capture('sms') };

    await setUrduLocale(true);
    const urduId = await notifyCancellation(userId, 150_000, 0, 'PKR');
    await runNotificationDispatchSweep({ adapters, deliveryIds: (await deliveriesFor(urduId)).map((d) => d.id) });
    const urduSent = sent.filter((s) => s.notificationId === urduId);
    expect(urduSent.length).toBeGreaterThan(0);
    for (const message of urduSent) {
      expect(message.title).toBe(ur.notifications.booking_cancelled.title);
      expect(message.body).toContain(formatMoney(150_000, 'PKR', 'ur'));
    }

    await setUrduLocale(false);
    const englishId = await notifyCancellation(userId, 150_000, 0, 'PKR');
    await runNotificationDispatchSweep({ adapters, deliveryIds: (await deliveriesFor(englishId)).map((d) => d.id) });
    const englishSent = sent.filter((s) => s.notificationId === englishId);
    expect(englishSent.length).toBeGreaterThan(0);
    for (const message of englishSent) expect(message.title).toBe('Booking cancelled');
  });
});
