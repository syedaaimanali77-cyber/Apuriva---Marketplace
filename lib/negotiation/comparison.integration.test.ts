import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { providerProfiles, services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer } from '@/lib/offers/decide';
import { getOfferComparison } from './compare';
import { reviseOffer } from './revise';
import {
  EXPIRED_MS_AGO,
  factor,
  fullOfferRow,
  isDatabaseReachable,
  reviseBody,
  seedOfferScenario,
  seedOffersFromEachProvider,
  setMatchRank,
  setStoredScoreBreakdown,
  shiftOfferWindow,
} from './negotiation-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 019 AC-2, AC-6, AC-10, AC-11 — the comparison contract. */
describe.skipIf(!dbReachable)('offer comparison (spec 019 AC-2/AC-6/AC-10/AC-11, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('returns 2–3 comparable offers with every required field and no admin-only matching data', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(2);

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    expect(comparison.available).toBe(true);
    expect(comparison.unavailableReason).toBeNull();
    expect(comparison.maxOffers).toBe(3);
    expect(comparison.offers).toHaveLength(2);
    expect(comparison.offers.map((o) => o.offerId).sort()).toEqual([...offerIds].sort());

    const offer = comparison.offers[0]!;
    expect(Object.keys(offer).sort()).toEqual(
      [
        'approxDistanceKm',
        'availabilityFit',
        'badges',
        'currencyCode',
        'estimatedDurationMinutes',
        'expiresAt',
        'includedItems',
        'isTopMatch',
        'offerId',
        'previousPriceAmountMinorUnits',
        'priceAmountMinorUnits',
        'providerBusinessName',
        'providerMessage',
        'providerProfileId',
        'rating',
        'revisionNumber',
        'status',
        'whyThisProvider',
      ].sort(),
    );
    expect(typeof offer.priceAmountMinorUnits).toBe('number');
    expect(offer.currencyCode).toBe('PKR');
    expect(offer.includedItems).toEqual(['Labour']);
    // Spec 017 AC-6: no score, weight, breakdown value, rank number or exclusion reason ever reaches a customer.
    expect(JSON.stringify(comparison)).not.toMatch(/scoreMicros|scoreBreakdown|score_breakdown|normalized|weight|exclusionReason|"rank"/i);
    // Exactly one Top Match.
    expect(comparison.offers.filter((o) => o.isTopMatch)).toHaveLength(1);
  });

  it('orders canonically by rank and marks the best-ranked offer as Top Match', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(3);
    await setMatchRank(requestId, providers[0]!.providerProfileId, 3);
    await setMatchRank(requestId, providers[1]!.providerProfileId, 1);
    await setMatchRank(requestId, providers[2]!.providerProfileId, 2);

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    expect(comparison.offers.map((o) => o.providerProfileId)).toEqual([
      providers[1]!.providerProfileId,
      providers[2]!.providerProfileId,
      providers[0]!.providerProfileId,
    ]);
    expect(comparison.offers[0]!.isTopMatch).toBe(true);
    expect(comparison.offers.filter((o) => o.isTopMatch)).toHaveLength(1);
  });

  it('returns at most 3 offers even when more are comparable', async () => {
    const { customer, requestId } = await seedOffersFromEachProvider(4);
    const comparison = await getOfferComparison(customer.userId, requestId, null);
    expect(comparison.offers).toHaveLength(3);
  });

  it('previousPriceAmountMinorUnits and revisionNumber reflect the revision chain', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(2);
    const { offer: revised } = await reviseOffer(providers[0]!.userId, providers[0]!.providerProfileId, offerIds[0]!, randomUUID(), reviseBody({ priceAmountMinorUnits: 240_000 }));

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    const revisedEntry = comparison.offers.find((o) => o.offerId === revised.id)!;
    expect(revisedEntry).toMatchObject({ revisionNumber: 1, previousPriceAmountMinorUnits: 300_000, priceAmountMinorUnits: 240_000 });
    // The superseded row is never comparable.
    expect(comparison.offers.map((o) => o.offerId)).not.toContain(offerIds[0]);

    const original = comparison.offers.find((o) => o.offerId === offerIds[1])!;
    expect(original.revisionNumber).toBe(0);
    expect(original.previousPriceAmountMinorUnits).toBeNull();
  });

  it('rating is null and the verified badge follows lifecycle_status', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(2);
    await getDb().update(providerProfiles).set({ lifecycleStatus: 'paused' }).where(eq(providerProfiles.id, providers[1]!.providerProfileId));

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    for (const offer of comparison.offers) expect(offer.rating).toBeNull();
    expect(comparison.offers.find((o) => o.providerProfileId === providers[0]!.providerProfileId)!.badges).toEqual(['verified']);
    expect(comparison.offers.find((o) => o.providerProfileId === providers[1]!.providerProfileId)!.badges).toEqual([]);
  });

  it('whyThisProvider derives from the stored score_breakdown, not recomputation', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(2);
    await setMatchRank(requestId, providers[0]!.providerProfileId, 1);
    await setMatchRank(requestId, providers[1]!.providerProfileId, 2);
    await setStoredScoreBreakdown(requestId, providers[0]!.providerProfileId, {
      availability: factor(1),
      location: factor(0.95),
      serviceMatch: factor(1),
    });
    await setStoredScoreBreakdown(requestId, providers[1]!.providerProfileId, {
      availability: factor(0.5),
      location: factor(0.2),
      rating: factor(1, false),
    });

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    const top = comparison.offers.find((o) => o.providerProfileId === providers[0]!.providerProfileId)!;
    const other = comparison.offers.find((o) => o.providerProfileId === providers[1]!.providerProfileId)!;
    expect(top.whyThisProvider).toEqual(['top_match', 'available_at_requested_time', 'nearby']);
    expect(top.availabilityFit).toBe('exact');
    expect(other.whyThisProvider).toEqual([]);
    expect(other.availabilityFit).toBe('same_day');

    // Deterministic: reading again returns the same reasons.
    const again = await getOfferComparison(customer.userId, requestId, null);
    expect(again.offers.map((o) => o.whyThisProvider)).toEqual(comparison.offers.map((o) => o.whyThisProvider));
  });

  it('available false with fewer_than_two_comparable_offers for 0 and 1 live offers', async () => {
    const none = await seedOfferScenario();
    const empty = await getOfferComparison(none.customer.userId, none.requestId, null);
    // A request with no offers is still `matching`, so that reason wins first.
    expect(empty.available).toBe(false);
    expect(empty.offers).toEqual([]);

    const one = await seedOffersFromEachProvider(1);
    const single = await getOfferComparison(one.customer.userId, one.requestId, null);
    expect(single).toMatchObject({ available: false, unavailableReason: 'fewer_than_two_comparable_offers', offers: [] });

    // An expired offer is not comparable, so two offers can still be "fewer than two".
    const two = await seedOffersFromEachProvider(2);
    await shiftOfferWindow(two.offerIds[0]!, EXPIRED_MS_AGO);
    const expired = await getOfferComparison(two.customer.userId, two.requestId, null);
    expect(expired).toMatchObject({ available: false, unavailableReason: 'fewer_than_two_comparable_offers' });
  });

  it('available false with request_not_open_for_offers after selection', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(2);
    await acceptOffer(customer.userId, offerIds[0]!, randomUUID());

    const comparison = await getOfferComparison(customer.userId, requestId, null);
    expect(comparison).toMatchObject({ available: false, unavailableReason: 'request_not_open_for_offers', offers: [] });
  });

  it('available false with pricing_model_not_offer_based', async () => {
    const { customer, requestId, serviceId } = await seedOffersFromEachProvider(2);
    await getDb().update(services).set({ pricingModel: 'fixed' }).where(eq(services.id, serviceId));

    const comparison = await getOfferComparison(customer.userId, requestId, null);
    expect(comparison).toMatchObject({ available: false, unavailableReason: 'pricing_model_not_offer_based', offers: [] });
  });

  it('422 OFFER_NOT_COMPARABLE for expired, revised or another request’s offer, listing only supplied ids', async () => {
    const { customer, providers, requestId, offerIds } = await seedOffersFromEachProvider(3);
    const other = await seedOffersFromEachProvider(2);

    await shiftOfferWindow(offerIds[2]!, EXPIRED_MS_AGO);
    await expect(getOfferComparison(customer.userId, requestId, `${offerIds[0]},${offerIds[2]}`)).rejects.toMatchObject({
      code: 'OFFER_NOT_COMPARABLE',
      status: 422,
      details: { offerIds: [offerIds[2]] },
    });

    const { offer: revised } = await reviseOffer(providers[1]!.userId, providers[1]!.providerProfileId, offerIds[1]!, randomUUID(), reviseBody());
    await expect(getOfferComparison(customer.userId, requestId, `${offerIds[0]},${offerIds[1]}`)).rejects.toMatchObject({
      code: 'OFFER_NOT_COMPARABLE',
      details: { offerIds: [offerIds[1]] },
    });
    // The revision itself is comparable.
    const ok = await getOfferComparison(customer.userId, requestId, `${offerIds[0]},${revised.id}`);
    expect(ok.offers.map((o) => o.offerId).sort()).toEqual([offerIds[0], revised.id].sort());

    // Another request's offer is simply "not comparable here" — it leaks nothing about that offer.
    await expect(getOfferComparison(customer.userId, requestId, `${offerIds[0]},${other.offerIds[0]}`)).rejects.toMatchObject({
      code: 'OFFER_NOT_COMPARABLE',
      details: { offerIds: [other.offerIds[0]] },
    });
  });

  it('rejects more than 3 ids, fewer than 2, duplicates and malformed ids before reading anything', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(4);

    await expect(getOfferComparison(customer.userId, requestId, offerIds.join(','))).rejects.toMatchObject({
      code: 'COMPARISON_LIMIT_EXCEEDED',
      status: 422,
    });
    await expect(getOfferComparison(customer.userId, requestId, offerIds[0]!)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(getOfferComparison(customer.userId, requestId, `${offerIds[0]},${offerIds[0]}`)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(getOfferComparison(customer.userId, requestId, `${offerIds[0]},nope`)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('404 REQUEST_NOT_FOUND for another customer’s request — ids cannot be probed', async () => {
    const { requestId } = await seedOffersFromEachProvider(2);
    const outsider = await seedOfferScenario();

    await expect(getOfferComparison(outsider.customer.userId, requestId, null)).rejects.toMatchObject({
      code: 'REQUEST_NOT_FOUND',
      status: 404,
    });
    await expect(getOfferComparison(outsider.customer.userId, 'not-a-uuid', null)).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
  });

  it('comparison read marks returned sent offers viewed', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(2);
    expect((await fullOfferRow(offerIds[0]!)).status).toBe('sent');

    const comparison = await getOfferComparison(customer.userId, requestId, null);

    expect((await fullOfferRow(offerIds[0]!)).status).toBe('viewed');
    expect(comparison.offers.every((o) => o.status === 'viewed' || o.status === 'sent')).toBe(true);
  });

  it('serverNow is the database clock and expiresAt is the offer’s own window', async () => {
    const { customer, requestId, offerIds } = await seedOffersFromEachProvider(2);
    const comparison = await getOfferComparison(customer.userId, requestId, null);

    const stored = await fullOfferRow(offerIds[0]!);
    const entry = comparison.offers.find((o) => o.offerId === offerIds[0])!;
    expect(new Date(entry.expiresAt).getTime()).toBe(stored.expires_at.getTime());
    expect(new Date(comparison.serverNow).getTime()).toBeLessThan(stored.expires_at.getTime());
  });
});
