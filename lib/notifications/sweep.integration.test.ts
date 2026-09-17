import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as CRON } from '@/app/api/v1/cron/notification-dispatch-sweep/route';
import { getDb } from '@/lib/db';
import type { ChannelAdapterSet } from './channels';
import { notify } from './create';
import { runNotificationDispatchSweep } from './dispatch';
import { createUser, deliveriesFor, isDatabaseReachable, setPreferences } from './notifications-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 026 §6 "Integration — sweep": due-only claims, overlap safety, backoff. */
describe.skipIf(!dbReachable)('notification dispatch sweep (spec 026, integration)', () => {
  it('claims only due rows and honours backoff', async () => {
    const userId = await createUser();
    await setPreferences(userId, { payments: { push: true, sms: true } });
    const result = await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:due' });
    if (result.status !== 'created') throw new Error('expected created');
    const rows = await deliveriesFor(result.notification.id);
    // push due now; email in the future; sms already terminal.
    await getDb().execute(sql`UPDATE notification_deliveries SET next_attempt_at = clock_timestamp() + interval '10 minutes' WHERE id = ${rows[1]!.id}`);
    await getDb().execute(sql`UPDATE notification_deliveries SET status = 'failed', next_attempt_at = NULL WHERE id = ${rows[2]!.id}`);

    const delivered: string[] = [];
    const adapter = (channel: 'push' | 'email' | 'sms') => ({
      channel,
      deliver: async () => {
        delivered.push(channel);
        return { outcome: 'delivered' as const, providerReference: null };
      },
    });
    const adapters: ChannelAdapterSet = { push: adapter('push'), email: adapter('email'), sms: adapter('sms') };
    const swept = await runNotificationDispatchSweep({ adapters, deliveryIds: rows.map((r) => r.id) });
    expect(swept.claimed).toBe(1);
    expect(delivered).toEqual(['push']);
    expect((await deliveriesFor(result.notification.id)).map((d) => d.status)).toEqual(['delivered', 'pending', 'failed']);
  });

  it('is idempotent across overlapping runs (FOR UPDATE SKIP LOCKED): each row is attempted once', async () => {
    const userId = await createUser();
    await setPreferences(userId, { security: { push: true, sms: true } });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await notify({ recipientUserId: userId, type: 'security_alert', eventKey: `security_alert:overlap:${i}` });
      if (result.status !== 'created') throw new Error('expected created');
      ids.push(...(await deliveriesFor(result.notification.id)).map((d) => d.id));
    }
    expect(ids).toHaveLength(15);

    let calls = 0;
    const slow = (channel: 'push' | 'email' | 'sms') => ({
      channel,
      deliver: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { outcome: 'delivered' as const, providerReference: null };
      },
    });
    const adapters: ChannelAdapterSet = { push: slow('push'), email: slow('email'), sms: slow('sms') };
    const runs = await Promise.all([1, 2, 3].map(() => runNotificationDispatchSweep({ adapters, deliveryIds: ids })));

    expect(calls).toBe(15);
    expect(runs.reduce((sum, run) => sum + run.claimed, 0)).toBe(15);
    expect(runs.reduce((sum, run) => sum + run.delivered, 0)).toBe(15);
    // A later run finds nothing to do.
    expect((await runNotificationDispatchSweep({ adapters, deliveryIds: ids })).claimed).toBe(0);
  });

  it('skips queued deliveries of a deleted account', async () => {
    const userId = await createUser();
    const result = await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:deleted' });
    if (result.status !== 'created') throw new Error('expected created');
    await getDb().execute(sql`UPDATE users SET lifecycle_status = 'deleted' WHERE id = ${userId}`);
    const rows = await deliveriesFor(result.notification.id);
    const swept = await runNotificationDispatchSweep({ adapters: {}, deliveryIds: rows.map((r) => r.id) });
    expect(swept.skipped).toBe(1);
    expect((await deliveriesFor(result.notification.id))[0]).toMatchObject({ status: 'skipped', skip_reason: 'account_deleted' });
  });

  it('the cron route requires the bearer CRON_SECRET, like every other cron route', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const url = 'http://localhost/api/v1/cron/notification-dispatch-sweep';
      expect((await CRON(new NextRequest(url))).status).toBe(401);
      expect((await CRON(new NextRequest(url, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
      // The authorized path is not invoked here: an unscoped sweep would claim other suites' queued rows.
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });
});
