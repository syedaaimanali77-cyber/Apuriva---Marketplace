import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as CRON_OFFER_EXPIRY_SWEEP } from '@/app/api/v1/cron/offer-expiry-sweep/route';
import { acceptOffer } from './decide';
import { queryRows } from './db';
import { EXPIRY_SWEEP_BATCH_SIZE, EXPIRY_SWEEP_MAX_DURATION_MS, runOfferExpirySweep } from './expiry';
import { getOfferForProvider, listOffersForCustomer } from './read';
import {
  isDatabaseReachable,
  offerHistory,
  seedOfferScenario,
  sendOffer,
  shiftOfferWindow,
  storedOffer,
  waitForDatabaseClockPast,
} from './offers-test-support';

const dbReachable = await isDatabaseReachable();

/** These tests register several accounts and run matching before the sweep; under full-suite CPU
 * contention that setup alone can exceed the repository's default 15 s (the same contention
 * vitest.config.ts documents). The assertions themselves involve no waiting. */
const SEED_HEAVY_TIMEOUT_MS = 60_000;

/**
 * Spec 018 AC-3 and AC-6(d). Every test that runs the sweep — or that depends on an expired offer NOT yet
 * being persisted by it — lives in this one file: suites run in parallel against one shared test
 * database, and within a file tests run sequentially. Assertions are always about this test's own offer
 * ids, never global counts, because other files' expired offers are legitimately swept too.
 */
describe.skipIf(!dbReachable)('offer expiry sweep (spec 018 AC-3, AC-6(d), integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('the decided bounds: batches of 500, a 45 s run budget, and a * * * * * schedule', async () => {
    expect(EXPIRY_SWEEP_BATCH_SIZE).toBe(500);
    expect(EXPIRY_SWEEP_MAX_DURATION_MS).toBe(45_000);
    const { readFileSync } = await import('node:fs');
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons).toContainEqual({ path: '/api/v1/cron/offer-expiry-sweep', schedule: '* * * * *' });
  });

  it('reads report expired as soon as expires_at passes, before the sweep persists it', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;
    const offer = await sendOffer(provider, requestId);
    await shiftOfferWindow(offer.id, 121_000);

    expect((await storedOffer(offer.id)).status).toBe('sent');
    expect((await getOfferForProvider(provider.providerProfileId, offer.id)).status).toBe('expired');
    const { data } = await listOffersForCustomer(customer.userId, requestId, { limit: 20, offset: 0 });
    expect(data[0]?.status).toBe('expired');
  });

  it('AC-3: persists expired with a null-actor history row, without any client read', async () => {
    const { providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const sentOffer = await sendOffer(providers[0]!, requestId);
    const viewedOffer = await sendOffer(providers[1]!, requestId);
    await getDb().execute(sql`UPDATE offers SET status = 'viewed', viewed_at = clock_timestamp() WHERE id = ${viewedOffer.id}`);
    await shiftOfferWindow(sentOffer.id, 121_000);
    await shiftOfferWindow(viewedOffer.id, 121_000);

    await runOfferExpirySweep();

    expect((await storedOffer(sentOffer.id)).status).toBe('expired');
    expect((await storedOffer(viewedOffer.id)).status).toBe('expired');
    expect((await offerHistory(sentOffer.id)).at(-1)).toEqual({ from_status: 'sent', to_status: 'expired', actor_user_id: null });
    expect((await offerHistory(viewedOffer.id)).at(-1)).toEqual({ from_status: 'viewed', to_status: 'expired', actor_user_id: null });
  });

  it('never touches live, accepted, declined or withdrawn offers', async () => {
    const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
    const live = await sendOffer(providers[0]!, requestId);
    const accepted = await sendOffer(providers[1]!, requestId);
    await acceptOffer(customer.userId, accepted.id, randomUUID());
    await shiftOfferWindow(accepted.id, 200_000);

    await runOfferExpirySweep();
    expect((await storedOffer(live.id)).status).toBe('sent');
    expect((await storedOffer(accepted.id)).status).toBe('accepted');
  });

  it('expires more than one batch in a single run', async () => {
    const { providers, requestId } = await seedOfferScenario({ providerCount: 5 });
    const offers = await Promise.all(providers.map((p) => sendOffer(p, requestId)));
    for (const offer of offers) await shiftOfferWindow(offer.id, 121_000);

    const result = await runOfferExpirySweep({ batchSize: 2 });
    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(result.expired).toBeGreaterThanOrEqual(5);
    for (const offer of offers) expect((await storedOffer(offer.id)).status).toBe('expired');
  }, SEED_HEAVY_TIMEOUT_MS);

  it('stops starting new batches once the run budget is spent', async () => {
    const { providers, requestId } = await seedOfferScenario({ providerCount: 3 });
    const offers = await Promise.all(providers.map((p) => sendOffer(p, requestId)));
    for (const offer of offers) await shiftOfferWindow(offer.id, 121_000);

    const result = await runOfferExpirySweep({ batchSize: 1, maxDurationMs: 0 });
    expect(result.batches).toBe(1);
  }, SEED_HEAVY_TIMEOUT_MS);

  it('re-running never double-expires (one expired history row per offer)', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    await shiftOfferWindow(offer.id, 121_000);

    await Promise.all([runOfferExpirySweep(), runOfferExpirySweep()]);
    await runOfferExpirySweep();
    const expiredRows = (await offerHistory(offer.id)).filter((h) => h.to_status === 'expired');
    expect(expiredRows).toHaveLength(1);
  });

  it('SKIP LOCKED: a due offer locked by an in-flight decision is skipped, then expired by the next run', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    await shiftOfferWindow(offer.id, 121_000);

    const holder = await getPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM offers WHERE id = $1 FOR UPDATE', [offer.id]);
      await runOfferExpirySweep();
      expect((await storedOffer(offer.id)).status).toBe('sent');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }

    await runOfferExpirySweep();
    expect((await storedOffer(offer.id)).status).toBe('expired');
  });

  it('AC-5 rule 10: a stale, not-yet-swept offer is persisted expired inside the creating transaction', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;
    const stale = await sendOffer(provider, requestId);
    await shiftOfferWindow(stale.id, 121_000);
    expect((await storedOffer(stale.id)).status).toBe('sent');

    const fresh = await sendOffer(provider, requestId);
    expect(fresh.status).toBe('sent');
    expect((await storedOffer(stale.id)).status).toBe('expired');
    expect((await offerHistory(stale.id)).at(-1)).toEqual({ from_status: 'sent', to_status: 'expired', actor_user_id: null });
  });

  it('(d) accept racing the sweep at the boundary never yields both accepted and expired', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await shiftOfferWindow(offer.id, 119_700);
      const { expires_at: expiresAt } = await storedOffer(offer.id);
      await waitForDatabaseClockPast(new Date(new Date(expiresAt).getTime() - 30));

      const [acceptResult] = await Promise.allSettled([
        acceptOffer(customer.userId, offer.id, randomUUID()),
        runOfferExpirySweep(),
      ]);

      const stored = await storedOffer(offer.id);
      const terminal = (await offerHistory(offer.id)).filter((h) => h.to_status === 'accepted' || h.to_status === 'expired');
      expect(terminal.length).toBeLessThanOrEqual(1);
      if (acceptResult.status === 'fulfilled') {
        expect(stored.status).toBe('accepted');
        expect(terminal.map((h) => h.to_status)).toEqual(['accepted']);
      } else {
        expect(acceptResult.reason).toMatchObject({ code: 'OFFER_EXPIRED' });
        expect(stored.status).not.toBe('accepted');
      }
    }
  }, SEED_HEAVY_TIMEOUT_MS);

  it('the cron route runs the sweep when the bearer secret matches', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const offer = await sendOffer(providers[0]!, requestId);
    await shiftOfferWindow(offer.id, 121_000);

    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-offer-sweep-secret';
    try {
      const res = await CRON_OFFER_EXPIRY_SWEEP(
        new NextRequest('http://localhost/api/v1/cron/offer-expiry-sweep', {
          headers: { authorization: 'Bearer test-offer-sweep-secret' },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.expired).toBeGreaterThanOrEqual(1);
    } finally {
      process.env.CRON_SECRET = previous;
    }
    expect((await storedOffer(offer.id)).status).toBe('expired');
  });

  it('the stored window of an expired offer still satisfies expires_at = sent_at + 2 minutes', async () => {
    const rows = await queryRows<{ bad: number }>(
      getDb(),
      sql`SELECT count(*)::int AS bad FROM offers WHERE sent_at IS NOT NULL AND expires_at - sent_at <> interval '2 minutes'`,
    );
    expect(rows[0]!.bad).toBe(0);
  });
});
