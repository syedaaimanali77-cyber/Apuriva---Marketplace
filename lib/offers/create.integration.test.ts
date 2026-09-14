import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { requestProviderMatches, requests } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { declineRequest } from '@/lib/matching/provider-requests';
import { createOffer } from './create';
import { declineOffer, withdrawOffer } from './decide';
import { queryRows } from './db';
import {
  isDatabaseReachable,
  offerBody,
  offerHistory,
  registerProvider,
  requestStatus,
  seedOfferScenario,
  sendOffer,
  shiftOfferWindow,
  storedOffer,
} from './offers-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('lib/offers/create (spec 018 AC-5, AC-7, AC-9, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  describe('AC-7: who may send an offer, and the server-computed window', () => {
    it('first offer: expires_at = sent_at + exactly 2 minutes, request matching -> offers_open, provider_response offer_sent, history rows', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const [provider] = providers;
      expect(await requestStatus(requestId)).toBe('matching');

      const offer = await sendOffer(provider!, requestId);
      expect(offer.status).toBe('sent');
      expect(Date.parse(offer.expiresAt) - Date.parse(offer.sentAt)).toBe(120_000);
      expect((await storedOffer(offer.id)).window_ok).toBe(true);

      expect(await requestStatus(requestId)).toBe('offers_open');
      const [match] = await getDb()
        .select({ response: requestProviderMatches.providerResponse, respondedAt: requestProviderMatches.respondedAt })
        .from(requestProviderMatches)
        .where(eq(requestProviderMatches.providerProfileId, provider!.providerProfileId));
      expect(match!.response).toBe('offer_sent');
      expect(match!.respondedAt).not.toBeNull();

      expect(await offerHistory(offer.id)).toEqual([
        { from_status: null, to_status: 'draft', actor_user_id: provider!.userId },
        { from_status: 'draft', to_status: 'sent', actor_user_id: provider!.userId },
      ]);
      const requestHistory = await queryRows<{ from_status: string; to_status: string }>(
        getDb(),
        sql`SELECT from_status, to_status FROM requests_status_history WHERE request_id = ${requestId} AND to_status = 'offers_open'`,
      );
      expect(requestHistory).toEqual([{ from_status: 'matching', to_status: 'offers_open' }]);
    });

    it('client-supplied sentAt/expiresAt/status are ignored — the database computes the window', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId, {
        sentAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2999-01-01T00:00:00.000Z',
        status: 'accepted',
      });
      expect(offer.status).toBe('sent');
      expect(offer.expiresAt).not.toBe('2999-01-01T00:00:00.000Z');
      expect(Date.parse(offer.expiresAt) - Date.parse(offer.sentAt)).toBe(120_000);
      // Created "now" by the database clock, not in the year 2000.
      expect(Math.abs(Date.parse(offer.sentAt) - Date.parse(offer.serverNow))).toBeLessThan(60_000);
    });

    it('a second provider offer on an offers_open request does not re-transition the request', async () => {
      const { providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      await sendOffer(providers[0]!, requestId);
      await sendOffer(providers[1]!, requestId);
      const rows = await queryRows<{ n: number }>(
        getDb(),
        sql`SELECT count(*)::int AS n FROM requests_status_history WHERE request_id = ${requestId} AND to_status = 'offers_open'`,
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('403 NOT_DISTRIBUTED_TO_PROVIDER for a provider with no match row, and for an unknown request id', async () => {
      const { requestId } = await seedOfferScenario();
      const outsider = await registerProvider();
      await expect(sendOffer(outsider, requestId)).rejects.toMatchObject({ code: 'NOT_DISTRIBUTED_TO_PROVIDER', status: 403 });
      await expect(sendOffer(outsider, randomUUID())).rejects.toMatchObject({ code: 'NOT_DISTRIBUTED_TO_PROVIDER', status: 403 });
    });

    it('403 NOT_DISTRIBUTED_TO_PROVIDER for a ranked-but-not-notified provider', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await getDb()
        .update(requestProviderMatches)
        .set({ notifiedAt: null })
        .where(eq(requestProviderMatches.providerProfileId, providers[0]!.providerProfileId));
      await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({ code: 'NOT_DISTRIBUTED_TO_PROVIDER' });
    });

    for (const pricingModel of ['fixed', 'package', 'hourly'] as const) {
      it(`422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL for a ${pricingModel} service`, async () => {
        const { providers, requestId } = await seedOfferScenario({ pricingModel });
        await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({
          code: 'ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL',
          status: 422,
        });
      });
    }

    it('custom-priced services accept offers like quote', async () => {
      const { providers, requestId } = await seedOfferScenario({ pricingModel: 'custom' });
      expect((await sendOffer(providers[0]!, requestId)).status).toBe('sent');
    });

    it('422 REQUEST_NOT_ACTIONABLE outside matching/offers_open (cancelled request)', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await getDb().update(requests).set({ status: 'cancelled' }).where(eq(requests.id, requestId));
      await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE', status: 422 });
    });

    it('422 REQUEST_NOT_ACTIONABLE when the provider already declined the request through spec 017', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await declineRequest(providers[0]!.providerProfileId, requestId);
      await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE' });
    });

    it('400 VALIDATION_ERROR on currencyCode when it differs from the request budget currency', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await getDb()
        .update(requests)
        .set({
          budgetMinAmountMinorUnits: 100_000,
          budgetMinCurrencyCode: 'PKR',
          budgetMaxAmountMinorUnits: 500_000,
          budgetMaxCurrencyCode: 'PKR',
        })
        .where(eq(requests.id, requestId));
      await expect(sendOffer(providers[0]!, requestId, { currencyCode: 'USD' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
        errors: [expect.objectContaining({ field: 'currencyCode' })],
      });
      expect((await sendOffer(providers[0]!, requestId, { currencyCode: 'PKR' })).status).toBe('sent');
    });

    it('400 VALIDATION_ERROR for an invalid body, with nothing written', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await expect(sendOffer(providers[0]!, requestId, { priceAmountMinorUnits: 12.5 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const rows = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM offers WHERE request_id = ${requestId}`);
      expect(rows[0]!.n).toBe(0);
    });
  });

  describe('AC-9: idempotent creation', () => {
    it('same key and body returns the original offer with replayed=true and exactly one row', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const key = randomUUID();
      const first = await createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId));
      const second = await createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId));
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.offer.id).toBe(first.offer.id);
      expect(second.offer.expiresAt).toBe(first.offer.expiresAt);

      const rows = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM offers WHERE request_id = ${requestId}`);
      expect(rows[0]!.n).toBe(1);
      expect(await offerHistory(first.offer.id)).toHaveLength(2);
    });

    it('same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const key = randomUUID();
      await createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId));
      await expect(
        createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId, { priceAmountMinorUnits: 999_999 })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 409 });
    });

    it('concurrent retries with the same key create exactly one offer', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const key = randomUUID();
      const results = await Promise.all([
        createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId)),
        createOffer(provider.userId, provider.providerProfileId, key, offerBody(requestId)),
      ]);
      expect(results[0].offer.id).toBe(results[1].offer.id);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    });
  });

  describe('AC-5: fresh offers', () => {
    it('409 LIVE_OFFER_EXISTS while the provider has a live offer', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await sendOffer(providers[0]!, requestId);
      await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({ code: 'LIVE_OFFER_EXISTS', status: 409 });
    });

    it('a provider can re-offer after expiry, with an independent window; the old row keeps its terminal status', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const first = await sendOffer(providers[0]!, requestId);
      await shiftOfferWindow(first.id, 121_000);

      const firstAfterShift = await storedOffer(first.id);

      const second = await sendOffer(providers[0]!, requestId, { priceAmountMinorUnits: 300_000 });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('sent');
      expect(Date.parse(second.expiresAt) - Date.parse(second.sentAt)).toBe(120_000);
      // Independent window: it starts after the previous one ended, and the previous one is unchanged.
      expect(Date.parse(second.sentAt)).toBeGreaterThan(new Date(firstAfterShift.expires_at).getTime());
      const firstNow = await storedOffer(first.id);
      expect(firstNow.status).toBe('expired');
      expect(new Date(firstNow.expires_at).getTime()).toBe(new Date(firstAfterShift.expires_at).getTime());
    });

    it('a provider can re-offer after withdrawing', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const first = await sendOffer(provider, requestId);
      await withdrawOffer(provider.userId, provider.providerProfileId, first.id);
      const second = await sendOffer(provider, requestId);
      expect(second.status).toBe('sent');
      expect((await storedOffer(first.id)).status).toBe('withdrawn');
    });

    it('re-offer after a customer decline is 422 REQUEST_NOT_ACTIONABLE (D-3)', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const first = await sendOffer(providers[0]!, requestId);
      await declineOffer(customer.userId, first.id);
      await expect(sendOffer(providers[0]!, requestId)).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE' });
    });
  });

  describe('database constraints (final safety layer)', () => {
    it('rejects an expires_at that is not exactly sent_at + 2 minutes (the window cannot be extended)', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await expect(
        getDb().execute(sql`UPDATE offers SET expires_at = expires_at + interval '1 second' WHERE id = ${offer.id}`),
      ).rejects.toThrow();
    });

    it('rejects a second live offer for the same provider and request even bypassing the application', async () => {
      const { providers, requestId } = await seedOfferScenario();
      await sendOffer(providers[0]!, requestId);
      await expect(
        getDb().execute(sql`
          INSERT INTO offers (request_id, provider_profile_id, status, price_amount_minor_units, price_currency_code, idempotency_key, idempotency_fingerprint)
          VALUES (${requestId}, ${providers[0]!.providerProfileId}, 'draft', 1, 'PKR', ${randomUUID()}, 'x')
        `),
      ).rejects.toThrow();
    });

    it('the trigger rejects transitions this spec does not seed: into revised, and out of expired/accepted', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      // Drizzle wraps the driver error; the trigger's own message is on `cause`.
      const triggerRejection = { cause: expect.objectContaining({ message: expect.stringMatching(/Invalid offers status transition/) }) };

      await expect(getDb().execute(sql`UPDATE offers SET status = 'revised' WHERE id = ${offer.id}`)).rejects.toMatchObject(triggerRejection);

      await getDb().execute(sql`UPDATE offers SET status = 'expired' WHERE id = ${offer.id}`);
      await expect(
        getDb().execute(sql`UPDATE offers SET status = 'accepted', decided_at = clock_timestamp(), accept_idempotency_key = 'k' WHERE id = ${offer.id}`),
      ).rejects.toMatchObject(triggerRejection);
      await expect(getDb().execute(sql`UPDATE offers SET status = 'sent' WHERE id = ${offer.id}`)).rejects.toMatchObject(triggerRejection);
    });

    it('rejects a non-positive price and a malformed currency at the database', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await expect(getDb().execute(sql`UPDATE offers SET price_amount_minor_units = 0 WHERE id = ${offer.id}`)).rejects.toThrow();
      await expect(getDb().execute(sql`UPDATE offers SET price_currency_code = 'pkr' WHERE id = ${offer.id}`)).rejects.toThrow();
    });
  });
});
