import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { acceptOffer, declineOffer, withdrawOffer } from '@/lib/offers/decide';
import { reviseOffer } from './revise';
import {
  EXPIRED_MS_AGO,
  fullOfferRow,
  isDatabaseReachable,
  requestStatus,
  reviseBody,
  seedOffersFromEachProvider,
  shiftOfferWindow,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();

async function acceptedCount(requestId: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM offers WHERE request_id = ${requestId} AND status = 'accepted'`,
  );
  return rows[0]!.n;
}

/**
 * Spec 019 AC-5 — the accepted price is the exact price of the row accepted. A superseded row can never
 * be accepted, and is never mistaken for an expired one.
 */
describe.skipIf(!dbReachable)('accepting a revision (spec 019 AC-5, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('accepting the new row stores that row’s exact price', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 265_000 }));

    const accepted = await acceptOffer(customer.userId, revised.id, randomUUID());

    expect(accepted).toMatchObject({ id: revised.id, status: 'accepted', priceAmountMinorUnits: 265_000, currencyCode: 'PKR' });
    expect(accepted.previousPriceAmountMinorUnits).toBe(300_000);
    const stored = await fullOfferRow(revised.id);
    expect(stored.status).toBe('accepted');
    expect(stored.price_amount_minor_units).toBe(265_000);
    expect(await requestStatus(requestId)).toBe('provider_selected');
    expect(await acceptedCount(requestId)).toBe(1);
  });

  it('accepting a revised row returns 409 OFFER_SUPERSEDED with currentOfferId and writes nothing', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    await expect(acceptOffer(customer.userId, offerIds[0]!, randomUUID())).rejects.toMatchObject({
      code: 'OFFER_SUPERSEDED',
      status: 409,
      details: { currentOfferId: revised.id },
    });

    expect((await fullOfferRow(offerIds[0]!)).status).toBe('revised');
    expect(await acceptedCount(requestId)).toBe(0);
    expect(await requestStatus(requestId)).toBe('offers_open');
  });

  it('decline and withdraw on a revised row return 409 OFFER_SUPERSEDED', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());

    await expect(declineOffer(customer.userId, offerIds[0]!)).rejects.toMatchObject({
      code: 'OFFER_SUPERSEDED',
      details: { currentOfferId: revised.id },
    });
    await expect(withdrawOffer(provider.userId, provider.providerProfileId, offerIds[0]!)).rejects.toMatchObject({
      code: 'OFFER_SUPERSEDED',
    });
    expect((await fullOfferRow(offerIds[0]!)).status).toBe('revised');
  });

  it('a superseded row is never reported as OFFER_EXPIRED, even once its own window has passed', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());
    // The superseded row's original window is now long past.
    await shiftOfferWindow(offerIds[0]!, EXPIRED_MS_AGO);

    await expect(acceptOffer(customer.userId, offerIds[0]!, randomUUID())).rejects.toMatchObject({ code: 'OFFER_SUPERSEDED' });
  });

  it('the new row is still bound by the 2-minute window: accepting it after expiry is OFFER_EXPIRED', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());
    await shiftOfferWindow(revised.id, EXPIRED_MS_AGO);

    await expect(acceptOffer(customer.userId, revised.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_EXPIRED', status: 422 });
  });

  it('accepting a revision is idempotent under the same key', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const { offer: revised } = await reviseOffer(provider.userId, provider.providerProfileId, offerIds[0]!, randomUUID(), reviseBody());
    const key = randomUUID();

    const first = await acceptOffer(customer.userId, revised.id, key);
    const replay = await acceptOffer(customer.userId, revised.id, key);
    expect(replay).toMatchObject({ id: first.id, status: 'accepted', decidedAt: first.decidedAt });
  });
});
