import { describe, expect, it } from 'vitest';
import { notify } from './create';
import { createUser, deliveriesFor, isDatabaseReachable, notificationCount, setPreferences } from './notifications-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 026 AC-7 — `UNIQUE (recipient_user_id, event_key)`. */
describe.skipIf(!dbReachable)('notify() deduplication (spec 026 AC-7, integration)', () => {
  it('the same event key creates one notification', async () => {
    const userId = await createUser();
    await setPreferences(userId, { payments: { push: true } });
    const first = await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:abc' });
    const second = await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:abc' });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    if (first.status !== 'created' || second.status !== 'duplicate') return;
    expect(second.notification).toEqual(first.notification);
    expect(await notificationCount(userId)).toBe(1);
    // A duplicate queues nothing more.
    expect(await deliveriesFor(first.notification.id)).toHaveLength(2);
  });

  it('the same key for a DIFFERENT recipient is a different notification', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const ra = await notify({ recipientUserId: a, type: 'booking_cancelled', eventKey: 'booking_cancelled:b9', params: { refundAmount: '1', feeAmount: '0' } });
    const rb = await notify({ recipientUserId: b, type: 'booking_cancelled', eventKey: 'booking_cancelled:b9', params: { refundAmount: '1', feeAmount: '0' } });
    expect([ra.status, rb.status]).toEqual(['created', 'created']);
  });

  it('concurrent handovers admit exactly one', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => notify({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'no_show_reported:race' })),
    );
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(7);
    const ids = new Set(results.map((r) => (r.status === 'suppressed' ? null : r.notification.id)));
    expect(ids.size).toBe(1);
    expect(await notificationCount(userId)).toBe(1);
    const [id] = [...ids];
    expect(await deliveriesFor(id!)).toHaveLength(1);
  });
});
