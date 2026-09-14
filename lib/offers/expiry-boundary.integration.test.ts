import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer } from './decide';
import {
  isDatabaseReachable,
  requestStatus,
  seedOfferScenario,
  sendOffer,
  shiftOfferWindow,
  storedOffer,
  waitForDatabaseClockPast,
} from './offers-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 018 AC-1/AC-2 — the timer boundary, judged by the DATABASE clock only. Windows are positioned
 * relative to `clock_timestamp()` (`shiftOfferWindow`), so there are no sleeps and no mocked database
 * clock. Tests that must tolerate the sweep persisting `expired` concurrently assert on outcomes that hold
 * either way.
 */
describe.skipIf(!dbReachable)('offer expiry boundary (spec 018 AC-1, AC-2, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-2: accepts at T+1:59 and moves the request to provider_selected', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    await shiftOfferWindow(offer.id, 119_000);

    expect((await acceptOffer(customer.userId, offer.id, randomUUID())).status).toBe('accepted');
    expect(await requestStatus(requestId)).toBe('provider_selected');
  });

  it('AC-1: rejects accept at T+2:00:00.001 and at T+2:00:01 with 422 OFFER_EXPIRED and writes nothing', async () => {
    for (const msAgo of [120_001, 121_000]) {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await shiftOfferWindow(offer.id, msAgo);

      await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_EXPIRED', status: 422 });
      const stored = await storedOffer(offer.id);
      expect(stored.status).not.toBe('accepted');
      expect(stored.decided_at).toBeNull();
      expect(stored.accept_idempotency_key).toBeNull();
      expect(await requestStatus(requestId)).toBe('offers_open');
    }
  });

  it('AC-1: an offer is expired exactly at expires_at (the boundary is exclusive)', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    // sent exactly 2:00.000 before the database clock at shift time — by the accept, the clock is ≥ expires_at.
    await shiftOfferWindow(offer.id, 120_000);
    await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
  });

  it('AC-1: an expired offer can never later become accepted, whatever key is used', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    await shiftOfferWindow(offer.id, 150_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
    }
    expect((await storedOffer(offer.id)).status).not.toBe('accepted');
  });

  it('AC-1: application/client clock drift cannot bypass expiry in either direction', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const expired = await sendOffer(providers[0]!, requestId);
    const live = await sendOffer(providers[1]!, requestId);
    await shiftOfferWindow(expired.id, 125_000);

    // Pretend the application/browser clock is decades behind: an expired offer is still rejected…
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
    await expect(acceptOffer(customer.userId, expired.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });

    // …and decades ahead: a live offer is still accepted.
    vi.setSystemTime(new Date('2090-01-01T00:00:00Z'));
    expect((await acceptOffer(customer.userId, live.id, randomUUID())).status).toBe('accepted');
  });

  it('AC-1: an accept whose lock wait ends after expires_at is rejected (clock read after the lock, not now())', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    // Live for ~1.5 more seconds of database time.
    await shiftOfferWindow(offer.id, 118_500);
    const { expires_at: expiresAt } = await storedOffer(offer.id);

    const holder = await getPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [requestId]);

      // The accept starts while the offer is still live, then blocks on the request lock.
      const attempt = acceptOffer(customer.userId, offer.id, randomUUID()).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await waitForDatabaseClockPast(new Date(expiresAt));
      await holder.query('COMMIT');

      const outcome = await attempt;
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toMatchObject({ code: 'OFFER_EXPIRED' });
    } finally {
      holder.release();
    }
    expect((await storedOffer(offer.id)).status).not.toBe('accepted');
  });
});
