import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { notify } from './create';
import { setMarketingConsent } from './preferences';
import { captureLogs, createUser, isDatabaseReachable, notificationCount, setPreferences } from './notifications-test-support';
import { queryRows } from './sql';

const dbReachable = await isDatabaseReachable();

let seq = 0;
const promo = (userId: string) =>
  notify({ recipientUserId: userId, type: 'promotion', eventKey: `promotion:${Date.now()}:${(seq += 1)}`, params: { headline: 'New in your area' } });

/** Spec 026 AC-3, AC-5 — consent and the frequency cap. */
describe.skipIf(!dbReachable)('marketing consent and frequency cap (spec 026 AC-3, AC-5, integration)', () => {
  const originalMax = process.env.MARKETING_MAX_PER_WINDOW;
  const originalDays = process.env.MARKETING_WINDOW_DAYS;
  afterEach(() => {
    if (originalMax === undefined) delete process.env.MARKETING_MAX_PER_WINDOW;
    else process.env.MARKETING_MAX_PER_WINDOW = originalMax;
    if (originalDays === undefined) delete process.env.MARKETING_WINDOW_DAYS;
    else process.env.MARKETING_WINDOW_DAYS = originalDays;
  });

  it('no consent creates nothing', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: true, push: true, sms: true } }, { consent: false });
    const logs = captureLogs();
    try {
      expect(await promo(userId)).toEqual({ status: 'suppressed', reason: 'no_consent' });
    } finally {
      logs.restore();
    }
    expect(await notificationCount(userId)).toBe(0);
    expect(logs.events()).toContainEqual(expect.objectContaining({ event: 'notification.marketing_suppressed', reason: 'no_consent' }));
    // A user who never saved preferences has no consent either.
    const fresh = await createUser();
    expect(await promo(fresh)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  });

  it('consent plus disabled promotions creates nothing', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: false, push: false, sms: false } }, { consent: true });
    expect(await promo(userId)).toEqual({ status: 'suppressed', reason: 'preference_disabled' });
    expect(await notificationCount(userId)).toBe(0);
  });

  it('withdrawal takes effect immediately', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: true } });
    await setMarketingConsent(userId, { consent: true });
    expect((await promo(userId)).status).toBe('created');

    await setMarketingConsent(userId, { consent: false });
    expect(await promo(userId)).toEqual({ status: 'suppressed', reason: 'no_consent' });
    expect(await notificationCount(userId)).toBe(1);

    // Consent history survives as append-only compliance records.
    const events = await queryRows<{ event_type: string }>(
      getDb(),
      sql`SELECT event_type FROM security_events WHERE user_id = ${userId} ORDER BY created_at ASC`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'notifications.marketing_consent_granted',
      'notifications.marketing_consent_withdrawn',
    ]);
  });

  it('consent is idempotent: a repeat grant keeps the original instant and records no new event', async () => {
    const userId = await createUser();
    const first = await setMarketingConsent(userId, { consent: true });
    const again = await setMarketingConsent(userId, { consent: true });
    expect(again.marketingConsentAt).toBe(first.marketingConsentAt);
    const withdraw = await setMarketingConsent(userId, { consent: false });
    const withdrawAgain = await setMarketingConsent(userId, { consent: false });
    expect([withdraw.marketingConsentAt, withdrawAgain.marketingConsentAt]).toEqual([null, null]);
    const [{ n }] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM security_events WHERE user_id = ${userId}`);
    expect(n).toBe(2);
    await expect(setMarketingConsent(userId, { consent: 'yes' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('the fourth promotion in the window is suppressed and logged', async () => {
    delete process.env.MARKETING_MAX_PER_WINDOW;
    delete process.env.MARKETING_WINDOW_DAYS;
    const userId = await createUser();
    // Three channels: counted per NOTIFICATION, so one promo on three channels is one send.
    await setPreferences(userId, { promotions: { email: true, push: true, sms: true } }, { consent: true });
    for (let i = 0; i < 3; i += 1) expect((await promo(userId)).status).toBe('created');

    const logs = captureLogs();
    try {
      expect(await promo(userId)).toEqual({ status: 'suppressed', reason: 'frequency_cap' });
    } finally {
      logs.restore();
    }
    expect(await notificationCount(userId)).toBe(3);
    expect(logs.events()).toContainEqual(
      expect.objectContaining({ event: 'notification.marketing_suppressed', reason: 'frequency_cap', recipientUserId: userId }),
    );
  });

  it('transactional sends do not count', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: true } }, { consent: true });
    for (let i = 0; i < 5; i += 1) {
      expect((await notify({ recipientUserId: userId, type: 'refund_completed', eventKey: `refund_completed:t${i}` })).status).toBe('created');
    }
    for (let i = 0; i < 3; i += 1) expect((await promo(userId)).status).toBe('created');
    expect((await promo(userId)).status).toBe('suppressed');
  });

  it('the window rolls: promotions older than MARKETING_WINDOW_DAYS no longer count', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: true } }, { consent: true });
    for (let i = 0; i < 3; i += 1) expect((await promo(userId)).status).toBe('created');
    expect((await promo(userId)).status).toBe('suppressed');

    await getDb().execute(sql`
      UPDATE notifications SET created_at = clock_timestamp() - interval '8 days'
       WHERE recipient_user_id = ${userId} AND category = 'promotions'
    `);
    expect((await promo(userId)).status).toBe('created');
  });

  it('the cap and window are environment-configurable', async () => {
    process.env.MARKETING_MAX_PER_WINDOW = '1';
    const userId = await createUser();
    await setPreferences(userId, { promotions: { push: true } }, { consent: true });
    expect((await promo(userId)).status).toBe('created');
    expect(await promo(userId)).toEqual({ status: 'suppressed', reason: 'frequency_cap' });
  });

  it('concurrent promotions cannot race past the cap', async () => {
    const userId = await createUser();
    await setPreferences(userId, { promotions: { email: true } }, { consent: true });
    const results = await Promise.all(Array.from({ length: 6 }, () => promo(userId)));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(3);
    expect(await notificationCount(userId)).toBe(3);
  });
});
