import { describe, expect, it } from 'vitest';
import { notify } from './create';
import { countUnreadNotifications, listNotifications } from './inbox';
import { createUser, deliveriesFor, isDatabaseReachable, notificationCount, setPreferences } from './notifications-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 026 AC-1, AC-2 — creation and channel queuing. */
describe.skipIf(!dbReachable)('notify() creation (spec 026 AC-1, AC-2, integration)', () => {
  it('one event creates one notification and queues its enabled channels', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true, push: true, sms: false } });

    const result = await notify({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'no_show_reported:r1', params: { reportId: 'r1' } });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.notification).toMatchObject({ category: 'booking', type: 'no_show_reported', readAt: null });
    expect(result.channels).toEqual(['push', 'email']);

    // In-app: visible immediately.
    expect(await notificationCount(userId)).toBe(1);
    expect(await countUnreadNotifications(userId)).toBe(1);
    const { items } = await listNotifications(userId, { limit: 20, offset: 0 }, { unreadOnly: false });
    expect(items.map((n) => n.id)).toEqual([result.notification.id]);

    const deliveries = await deliveriesFor(result.notification.id);
    expect(deliveries.map((d) => [d.channel, d.status, d.attempts])).toEqual([
      ['push', 'pending', 0],
      ['email', 'pending', 0],
    ]);
    expect(deliveries.every((d) => d.next_attempt_at !== null)).toBe(true);
  });

  it('a disabled category still creates the in-app row and no deliveries', async () => {
    const userId = await createUser();
    await setPreferences(userId, { messages: { email: false, push: false, sms: false } });

    const result = await notify({ recipientUserId: userId, type: 'message_received', eventKey: 'message_received:m1' });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.channels).toEqual([]);
    expect(await notificationCount(userId)).toBe(1);
    expect(await deliveriesFor(result.notification.id)).toEqual([]);
  });

  it('with no preference row, defaults apply: in-app only for overridable, email for non-overridable', async () => {
    const userId = await createUser();
    const booking = await notify({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'd:1' });
    const refund = await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: 'd:2' });
    expect(booking.status === 'created' && booking.channels).toEqual([]);
    expect(refund.status === 'created' && refund.channels).toEqual(['email']);
  });

  it('non-overridable categories ignore a disabled preference', async () => {
    const userId = await createUser();
    // Unreachable through the API (422), written directly to prove resolution ignores it.
    await setPreferences(userId, { security: { email: false, push: false, sms: true } });
    const result = await notify({ recipientUserId: userId, type: 'security_alert', eventKey: 'security_alert:1' });
    expect(result.status === 'created' && result.channels).toEqual(['email', 'sms']);
    if (result.status !== 'created') return;
    expect((await deliveriesFor(result.notification.id)).map((d) => d.channel)).toEqual(['email', 'sms']);
  });

  it('bodies are rendered from the catalogue, never relayed, and params stay internal', async () => {
    const userId = await createUser();
    const result = await notify({
      recipientUserId: userId,
      type: 'booking_cancelled',
      eventKey: 'booking_cancelled:b1',
      params: { bookingId: 'b1', refundAmount: 'PKR 1,000.00', feeAmount: 'PKR 0.00' },
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.notification.body).toBe('A booking you are part of was cancelled. Refund: PKR 1,000.00. Cancellation fee: PKR 0.00.');
    expect(Object.keys(result.notification).sort()).toEqual(['body', 'category', 'createdAt', 'id', 'readAt', 'title', 'type']);
  });

  it('rejects an event without a deterministic key or with a missing template param', async () => {
    const userId = await createUser();
    await expect(notify({ recipientUserId: userId, type: 'security_alert', eventKey: ' ' })).rejects.toThrow(/eventKey/);
    await expect(notify({ recipientUserId: userId, type: 'no_show_resolved', eventKey: 'x:1' })).rejects.toThrow(/outcome/);
    expect(await notificationCount(userId)).toBe(0);
  });
});
