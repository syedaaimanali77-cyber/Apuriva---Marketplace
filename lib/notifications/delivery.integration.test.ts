import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { getSandboxChannelAdapters, getSandboxChannelRecords, resetSandboxChannelRecords } from './channels';
import { notify } from './create';
import { runNotificationDispatchSweep } from './dispatch';
import { setMarketingConsent } from './preferences';
import {
  captureLogs,
  createUser,
  deliveriesFor,
  isDatabaseReachable,
  makeDue,
  scriptedAdapters,
  setPreferences,
} from './notifications-test-support';

const dbReachable = await isDatabaseReachable();

async function created(input: Parameters<typeof notify>[0]): Promise<string> {
  const result = await notify(input);
  if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
  return result.notification.id;
}

async function sweep(notificationId: string, adapters: Parameters<typeof runNotificationDispatchSweep>[0]['adapters']) {
  const ids = (await deliveriesFor(notificationId)).map((d) => d.id);
  return runNotificationDispatchSweep({ adapters, deliveryIds: ids });
}

/** Spec 026 AC-6, AC-10 — outbound delivery, retry, fallback and escalation. */
describe.skipIf(!dbReachable)('notification delivery (spec 026 AC-6, AC-10, integration)', () => {
  const originalMax = process.env.NOTIFICATION_MAX_ATTEMPTS;
  afterEach(() => {
    if (originalMax === undefined) delete process.env.NOTIFICATION_MAX_ATTEMPTS;
    else process.env.NOTIFICATION_MAX_ATTEMPTS = originalMax;
    resetSandboxChannelRecords();
  });

  it('sandbox delivery marks delivered with its self-describing reference', async () => {
    const userId = await createUser();
    await setPreferences(userId, { payments: { push: true } });
    const id = await created({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:s1' });

    const result = await sweep(id, getSandboxChannelAdapters());
    expect(result.delivered).toBe(2);
    const deliveries = await deliveriesFor(id);
    expect(deliveries.map((d) => d.status)).toEqual(['delivered', 'delivered']);
    expect(deliveries.every((d) => d.delivered_at !== null && d.attempts === 1)).toBe(true);
    expect(deliveries.every((d) => d.provider_reference?.startsWith('sandbox_notification_'))).toBe(true);
    expect(getSandboxChannelRecords().filter((r) => r.notificationId === id)).toHaveLength(2);
  });

  it('a critical failure retries with backoff and falls back in order', async () => {
    process.env.NOTIFICATION_MAX_ATTEMPTS = '3';
    const userId = await createUser();
    await setPreferences(userId, { security: { push: true } });
    const id = await created({ recipientUserId: userId, type: 'security_alert', eventKey: 'security_alert:f1' });
    // Created with push + email (floor). Push fails every time; email fails every time too.
    const { adapters, calls } = scriptedAdapters({ push: ['failed'], email: ['failed'], sms: ['delivered'] });

    await sweep(id, adapters);
    let rows = await deliveriesFor(id);
    expect(rows.map((d) => [d.channel, d.status, d.attempts])).toEqual([
      ['push', 'retrying', 1],
      ['email', 'retrying', 1],
    ]);
    // Backoff: 2^1 minutes, so an immediate re-run claims nothing.
    const minutes = (new Date(rows[0]!.next_attempt_at!).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(1.5);
    expect(minutes).toBeLessThanOrEqual(2.1);
    expect((await sweep(id, adapters)).claimed).toBe(0);

    // The user turns sms on meanwhile: it becomes a fallback candidate, not a parallel send.
    await setPreferences(userId, { security: { push: true, sms: true } });
    for (let i = 0; i < 2; i += 1) {
      await makeDue(id);
      await sweep(id, adapters);
    }
    rows = await deliveriesFor(id);
    expect(rows.map((d) => [d.channel, d.status, d.attempts])).toEqual([
      ['push', 'failed', 3],
      ['email', 'failed', 3],
      ['sms', 'pending', 0],
    ]);

    await makeDue(id);
    await sweep(id, adapters);
    rows = await deliveriesFor(id);
    expect(rows.find((d) => d.channel === 'sms')!.status).toBe('delivered');
    // Order of first contact per channel follows push → email → sms.
    expect([...new Set(calls.map((c) => c.channel))]).toEqual(['push', 'email', 'sms']);
  });

  it('exhausted attempts fail loudly', async () => {
    process.env.NOTIFICATION_MAX_ATTEMPTS = '2';
    const userId = await createUser();
    const id = await created({ recipientUserId: userId, type: 'service_notice', eventKey: 'service_notice:x1' });
    const { adapters } = scriptedAdapters({ email: ['failed'] });

    const logs = captureLogs();
    try {
      await sweep(id, adapters);
      await makeDue(id);
      await sweep(id, adapters);
    } finally {
      logs.restore();
    }
    const [row] = await deliveriesFor(id);
    expect(row).toMatchObject({ channel: 'email', status: 'failed', attempts: 2, failure_code: 'rejected', next_attempt_at: null });
    const exhausted = logs.events().filter((e) => e.event === 'notification.delivery_exhausted');
    expect(exhausted).toEqual([expect.objectContaining({ notificationId: id, category: 'operational', channel: 'email', attempts: 2 })]);
    // No title, body or params in any log line.
    expect(JSON.stringify(logs.events())).not.toContain('Important service notice');
  });

  it('unknown is never collapsed into delivered or failed', async () => {
    process.env.NOTIFICATION_MAX_ATTEMPTS = '2';
    const userId = await createUser();
    const id = await created({ recipientUserId: userId, type: 'refund_failed', eventKey: 'refund_failed:u1' });
    const { adapters } = scriptedAdapters({ email: ['unknown'] });

    const logs = captureLogs();
    try {
      await sweep(id, adapters);
      let [row] = await deliveriesFor(id);
      expect(row).toMatchObject({ status: 'retrying', attempts: 1, delivered_at: null });
      await makeDue(id);
      await sweep(id, adapters);
      [row] = await deliveriesFor(id);
      // At the ceiling: still `retrying`, no longer auto-claimed, escalated for an operator.
      expect(row).toMatchObject({ status: 'retrying', attempts: 2, next_attempt_at: null, delivered_at: null });
    } finally {
      logs.restore();
    }
    expect(logs.events()).toContainEqual(expect.objectContaining({ event: 'notification.delivery_exhausted', outcome: 'unknown' }));
    // A thrown adapter call is `unknown` too.
    const other = await created({ recipientUserId: userId, type: 'refund_failed', eventKey: 'refund_failed:u2' });
    await sweep(other, { email: { channel: 'email', deliver: async () => { throw new Error('timeout'); } } });
    expect((await deliveriesFor(other))[0]).toMatchObject({ status: 'retrying', attempts: 1 });
  });

  it('a non-critical failure is abandoned after one retry, without escalation', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true } });
    const id = await created({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'no_show_reported:nc1' });
    const { adapters, calls } = scriptedAdapters({ email: ['failed'], sms: ['delivered'] });

    const logs = captureLogs();
    try {
      await sweep(id, adapters);
      await makeDue(id);
      await sweep(id, adapters);
      await makeDue(id);
      await sweep(id, adapters);
    } finally {
      logs.restore();
    }
    const rows = await deliveriesFor(id);
    expect(rows).toEqual([expect.objectContaining({ channel: 'email', status: 'failed', attempts: 2 })]);
    expect(calls).toHaveLength(2);
    expect(logs.events().some((e) => e.event === 'notification.delivery_exhausted')).toBe(false);
  });

  it('no_adapter records skipped', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { push: true } });
    const id = await created({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'no_show_reported:na1' });
    await sweep(id, {});
    expect((await deliveriesFor(id))[0]).toMatchObject({ channel: 'push', status: 'skipped', skip_reason: 'no_adapter', attempts: 0 });
  });

  it('a channel switched off after queuing, and a promotion after consent withdrawal, are skipped — not sent', async () => {
    const userId = await createUser();
    await setPreferences(userId, { booking: { email: true }, promotions: { email: true } }, { consent: true });
    const booking = await created({ recipientUserId: userId, type: 'no_show_reported', eventKey: 'no_show_reported:off' });
    const promo = await created({ recipientUserId: userId, type: 'promotion', eventKey: 'promotion:off', params: { headline: 'Hi' } });

    await setPreferences(userId, { promotions: { email: true } }, { consent: true }); // booking email back to default off
    await setMarketingConsent(userId, { consent: false });
    const { adapters, calls } = scriptedAdapters({ email: ['delivered'] });
    await sweep(booking, adapters);
    await sweep(promo, adapters);
    expect(calls).toEqual([]);
    expect((await deliveriesFor(booking))[0]).toMatchObject({ status: 'skipped', skip_reason: 'preference_disabled' });
    expect((await deliveriesFor(promo))[0]).toMatchObject({ status: 'skipped', skip_reason: 'consent_withdrawn' });
  });

  it('under NODE_ENV=production with only a sandbox, the sweep marks nothing and reports unavailable', async () => {
    const userId = await createUser();
    const id = await created({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:prod' });
    const original = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    let result;
    const logs = captureLogs();
    try {
      result = await runNotificationDispatchSweep({ deliveryIds: (await deliveriesFor(id)).map((d) => d.id) });
    } finally {
      logs.restore();
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
    expect(result.providerUnavailable).toBe(true);
    expect(result.claimed).toBe(0);
    expect((await deliveriesFor(id))[0]).toMatchObject({ status: 'pending', attempts: 0, delivered_at: null });
  });

  it('the delivered pairing CHECK holds at the database', async () => {
    const userId = await createUser();
    const id = await created({ recipientUserId: userId, type: 'refund_completed', eventKey: 'refund_completed:ck' });
    await expect(
      getDb().execute(sql`UPDATE notification_deliveries SET status = 'delivered' WHERE notification_id = ${id}`),
    ).rejects.toThrow();
  });
});
