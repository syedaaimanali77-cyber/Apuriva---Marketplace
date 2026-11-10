import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { acceptOffer, declineOffer, withdrawOffer } from '@/lib/offers/decide';
import { runOfferExpirySweep } from '@/lib/offers/expiry';
import { sendCustomerMessage } from './messages';
import { reviseOffer } from './revise';
import { THREAD_MESSAGE_LIMIT } from './limits';
import {
  EXPIRED_MS_AGO,
  fullOfferRow,
  isDatabaseReachable,
  messageRows,
  reviseBody,
  revisionRows,
  seedOffersFromEachProvider,
  shiftOfferWindow,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 019 AC-9. Every concurrent call runs its own `getDb().transaction()`, which checks out a SEPARATE
 * physical connection from the pg Pool — these are real multi-connection races decided by PostgreSQL row
 * locks, following spec 018's `lib/offers/accept-race.integration.test.ts`.
 */
async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  const fulfilled: Awaited<T>[] = [];
  const rejected: { code?: string }[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else rejected.push(result.reason as { code?: string });
  }
  return { fulfilled, rejected };
}

async function liveOfferCount(requestId: string, providerProfileId: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM offers
         WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND status IN ('draft', 'sent', 'viewed')`,
  );
  return rows[0]!.n;
}

describe.skipIf(!dbReachable)('negotiation concurrency (spec 019 AC-9, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('revise vs accept — exactly one commits, never an accepted revised row', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;

    const { fulfilled, rejected } = await settle<unknown>([
      acceptOffer(customer.userId, offerIds[0]!, randomUUID()),
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody()),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is rejected by whichever rule fires first: the revise sees a claimed request or a
    // superseded/decided offer; the accept sees a superseded one.
    expect(['OFFER_SUPERSEDED', 'OFFER_ALREADY_DECIDED', 'REQUEST_ALREADY_CLAIMED']).toContain(rejected[0]!.code);

    const source = await fullOfferRow(offerIds[0]!);
    // The source is either accepted (accept won) or revised (revise won) — never both, never accepted-after-revised.
    expect(['accepted', 'revised']).toContain(source.status);
    if (source.status === 'revised') {
      const accepted = await queryRows<{ n: number }>(
        getDb(),
        sql`SELECT count(*)::int AS n FROM offers WHERE request_id = ${requestId} AND status = 'accepted'`,
      );
      expect(accepted[0]!.n).toBe(0);
    } else {
      expect(await revisionRows(requestId)).toHaveLength(0);
    }
    expect(await liveOfferCount(requestId, provider.providerProfileId)).toBeLessThanOrEqual(1);
  });

  it('two revisions of one source — one succeeds, the other is 409 OFFER_SUPERSEDED', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;

    const { fulfilled, rejected } = await settle([
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 280_000 })),
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 260_000 })),
    ]);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(['OFFER_SUPERSEDED', 'LIVE_OFFER_EXISTS']).toContain(rejected[0]!.code);
    expect(await revisionRows(requestId)).toHaveLength(1);
    expect(await liveOfferCount(requestId, provider.providerProfileId)).toBe(1);
  });

  it('same-key concurrent revisions — both return the identical new offer and write one revision', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const key = randomUUID();

    const { fulfilled, rejected } = await settle([
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, key, reviseBody()),
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, key, reviseBody()),
    ]);

    expect(rejected).toEqual([]);
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0]!.offer.id).toBe(fulfilled[1]!.offer.id);
    expect(await revisionRows(requestId)).toHaveLength(1);
    expect(await liveOfferCount(requestId, provider.providerProfileId)).toBe(1);
  });

  it('revise vs the expiry sweep — never both revised and expired, never two live offers', async () => {
    const { providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    // Put the source exactly at the boundary the sweep is about to act on.
    await shiftOfferWindow(offerIds[0]!, EXPIRED_MS_AGO);

    const { fulfilled } = await settle<unknown>([
      reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody()),
      runOfferExpirySweep(),
    ]);

    // The revision always succeeds here (an expired head may still be revised); the sweep never conflicts.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const source = await fullOfferRow(offerIds[0]!);
    expect(source.status).toBe('expired');
    expect(await liveOfferCount(requestId, provider.providerProfileId)).toBe(1);
    expect(await revisionRows(requestId)).toHaveLength(1);
  });

  it('revise vs withdraw and revise vs decline — one outcome each', async () => {
    const withdrawRace = await seedOffersFromEachProvider(1);
    const wp = withdrawRace.providers[0]!;
    const withdrawResult = await settle<unknown>([
      withdrawOffer(wp.userId, wp.providerProfileId, withdrawRace.offerIds[0]!),
      reviseOffer(wp.userId, wp.providerProfileId, withdrawRace.offerIds[0]!, randomUUID(), reviseBody()),
    ]);
    expect(withdrawResult.fulfilled).toHaveLength(1);
    expect(['OFFER_SUPERSEDED', 'OFFER_ALREADY_DECIDED']).toContain(withdrawResult.rejected[0]!.code);
    expect(['withdrawn', 'revised']).toContain((await fullOfferRow(withdrawRace.offerIds[0]!)).status);

    const declineRace = await seedOffersFromEachProvider(1);
    const dp = declineRace.providers[0]!;
    const declineResult = await settle<unknown>([
      declineOffer(declineRace.customer.userId, declineRace.offerIds[0]!),
      reviseOffer(dp.userId, dp.providerProfileId, declineRace.offerIds[0]!, randomUUID(), reviseBody()),
    ]);
    expect(declineResult.fulfilled).toHaveLength(1);
    expect(['declined', 'revised']).toContain((await fullOfferRow(declineRace.offerIds[0]!)).status);
  });

  it('concurrent messages never exceed the thread limit', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const providerProfileId = providers[0]!.providerProfileId;

    // Eight simultaneous sends against a limit of five.
    const attempts = Array.from({ length: 8 }, (_, i) =>
      sendCustomerMessage(customer.userId, requestId, providerProfileId, randomUUID(), { body: `Concurrent ${i}` }),
    );
    const { fulfilled, rejected } = await settle(attempts);

    expect(fulfilled.length).toBe(THREAD_MESSAGE_LIMIT);
    expect(rejected.every((error) => error.code === 'RATE_LIMITED')).toBe(true);
    expect(await messageRows(requestId, providerProfileId)).toHaveLength(THREAD_MESSAGE_LIMIT);
  });
});
