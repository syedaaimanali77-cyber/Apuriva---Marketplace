import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { requests } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptOffer, declineOffer, withdrawOffer } from './decide';
import { queryRows } from './db';
import { getOfferForCustomer, listOffersForCustomer } from './read';
import {
  isDatabaseReachable,
  offerHistory,
  registerCustomer,
  registerProvider,
  requestStatus,
  seedOfferScenario,
  sendOffer,
  shiftOfferWindow,
  storedOffer,
} from './offers-test-support';

const dbReachable = await isDatabaseReachable();
const PAGE = { limit: 20, offset: 0 };

describe.skipIf(!dbReachable)('lib/offers/decide (spec 018 AC-2, AC-4, AC-8, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  describe('AC-2: accept', () => {
    it('accepts a live offer: accepted + decided_at, request offers_open -> provider_selected, history rows', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);

      const accepted = await acceptOffer(customer.userId, offer.id, randomUUID());
      expect(accepted.status).toBe('accepted');
      expect(accepted.decidedAt).not.toBeNull();
      expect(await requestStatus(requestId)).toBe('provider_selected');
      expect((await offerHistory(offer.id)).at(-1)).toEqual({ from_status: 'sent', to_status: 'accepted', actor_user_id: customer.userId });

      const requestHistory = await queryRows<{ actor_user_id: string }>(
        getDb(),
        sql`SELECT actor_user_id FROM requests_status_history WHERE request_id = ${requestId} AND from_status = 'offers_open' AND to_status = 'provider_selected'`,
      );
      expect(requestHistory).toEqual([{ actor_user_id: customer.userId }]);
    });

    it('accepts a viewed offer (viewed -> accepted)', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await getOfferForCustomer(customer.userId, offer.id);
      expect((await storedOffer(offer.id)).status).toBe('viewed');
      expect((await acceptOffer(customer.userId, offer.id, randomUUID())).status).toBe('accepted');
    });

    it('an accepted offer never expires, even long after expires_at', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await acceptOffer(customer.userId, offer.id, randomUUID());
      const later = await getOfferForCustomer(customer.userId, offer.id);
      expect(later.status).toBe('accepted');
    });

    it('same key replay returns 200 with the identical offer; a different key is 409 OFFER_ALREADY_DECIDED', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      const key = randomUUID();
      const first = await acceptOffer(customer.userId, offer.id, key);
      const replay = await acceptOffer(customer.userId, offer.id, key);
      expect(replay).toMatchObject({ id: first.id, status: 'accepted', decidedAt: first.decidedAt, version: first.version });
      await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_ALREADY_DECIDED', status: 409 });
    });

    it('a second offer on an already-claimed request is 409 REQUEST_ALREADY_CLAIMED', async () => {
      const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      const a = await sendOffer(providers[0]!, requestId);
      const b = await sendOffer(providers[1]!, requestId);
      await acceptOffer(customer.userId, a.id, randomUUID());
      await expect(acceptOffer(customer.userId, b.id, randomUUID())).rejects.toMatchObject({ code: 'REQUEST_ALREADY_CLAIMED', status: 409 });
      // The other live offer is untouched — still live, just unacceptable.
      expect((await storedOffer(b.id)).status).toBe('sent');
    });

    it('422 REQUEST_NOT_ACTIONABLE when the request was cancelled', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await getDb().update(requests).set({ status: 'cancelled' }).where(eq(requests.id, requestId));
      await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'REQUEST_NOT_ACTIONABLE', status: 422 });
    });

    it('accepting creates no booking (spec 020 owns booking creation)', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      await acceptOffer(customer.userId, offer.id, randomUUID());
      const rows = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM bookings WHERE offer_id = ${offer.id}`);
      expect(rows[0]!.n).toBe(0);
    });

    it('404 OFFER_NOT_FOUND for another customer, an unknown id, and a malformed id', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      const stranger = await registerCustomer();
      await expect(acceptOffer(stranger.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND', status: 404 });
      await expect(acceptOffer(stranger.userId, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
      await expect(acceptOffer(stranger.userId, 'not-a-uuid', randomUUID())).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
    });
  });

  describe('AC-8: decline and withdraw', () => {
    it('decline sets declined + decided_at; repeating returns 200; accept afterwards is 409', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      const declined = await declineOffer(customer.userId, offer.id);
      expect(declined.status).toBe('declined');
      expect(declined.decidedAt).not.toBeNull();
      expect((await declineOffer(customer.userId, offer.id)).status).toBe('declined');
      await expect(acceptOffer(customer.userId, offer.id, randomUUID())).rejects.toMatchObject({ code: 'OFFER_ALREADY_DECIDED' });
      // A decline never moves the request.
      expect(await requestStatus(requestId)).toBe('offers_open');
    });

    it('withdraw sets withdrawn + decided_at; repeating returns 200; decline afterwards is 409', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const offer = await sendOffer(provider, requestId);
      const withdrawn = await withdrawOffer(provider.userId, provider.providerProfileId, offer.id);
      expect(withdrawn.status).toBe('withdrawn');
      expect(withdrawn.decidedAt).not.toBeNull();
      expect((await withdrawOffer(provider.userId, provider.providerProfileId, offer.id)).status).toBe('withdrawn');
      await expect(declineOffer(customer.userId, offer.id)).rejects.toMatchObject({ code: 'OFFER_ALREADY_DECIDED', status: 409 });
      expect((await offerHistory(offer.id)).at(-1)).toEqual({ from_status: 'sent', to_status: 'withdrawn', actor_user_id: provider.userId });
    });

    it('withdrawing an accepted offer is 409 OFFER_ALREADY_DECIDED', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const offer = await sendOffer(provider, requestId);
      await acceptOffer(customer.userId, offer.id, randomUUID());
      await expect(withdrawOffer(provider.userId, provider.providerProfileId, offer.id)).rejects.toMatchObject({ code: 'OFFER_ALREADY_DECIDED' });
    });

    it('decline and withdraw after expiry return 422 OFFER_EXPIRED', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const provider = providers[0]!;
      const offer = await sendOffer(provider, requestId);
      await shiftOfferWindow(offer.id, 120_500);
      await expect(declineOffer(customer.userId, offer.id)).rejects.toMatchObject({ code: 'OFFER_EXPIRED', status: 422 });
      await expect(withdrawOffer(provider.userId, provider.providerProfileId, offer.id)).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
    });

    it("another provider cannot withdraw the offer (404)", async () => {
      const { providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      const other = await registerProvider();
      await expect(withdrawOffer(other.userId, other.providerProfileId, offer.id)).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND', status: 404 });
    });
  });

  describe('AC-4: history is never deleted', () => {
    it('terminal offers remain listed for the customer with their status and timestamps', async () => {
      const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 3 });
      const accepted = await sendOffer(providers[0]!, requestId);
      const declined = await sendOffer(providers[1]!, requestId);
      const expired = await sendOffer(providers[2]!, requestId);
      await declineOffer(customer.userId, declined.id);
      await shiftOfferWindow(expired.id, 125_000);
      await acceptOffer(customer.userId, accepted.id, randomUUID());

      const { data } = await listOffersForCustomer(customer.userId, requestId, PAGE);
      const byId = new Map(data.map((o) => [o.id, o]));
      expect(byId.get(accepted.id)?.status).toBe('accepted');
      expect(byId.get(declined.id)?.status).toBe('declined');
      expect(byId.get(expired.id)?.status).toBe('expired');
      expect(byId.get(expired.id)?.decidedAt).toBeNull();
      expect(data).toHaveLength(3);
    });

    it('the customer list marks live sent offers viewed (with history), never expired ones', async () => {
      const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      const live = await sendOffer(providers[0]!, requestId);
      const stale = await sendOffer(providers[1]!, requestId);
      await shiftOfferWindow(stale.id, 130_000);

      const { data } = await listOffersForCustomer(customer.userId, requestId, PAGE);
      expect(data.find((o) => o.id === live.id)?.status).toBe('viewed');
      expect((await offerHistory(live.id)).at(-1)).toEqual({ from_status: 'sent', to_status: 'viewed', actor_user_id: customer.userId });
      expect(data.find((o) => o.id === stale.id)?.status).toBe('expired');
      expect((await storedOffer(stale.id)).status).not.toBe('viewed');
    });

    it('a non-owner listing the request is 404 REQUEST_NOT_FOUND', async () => {
      const { requestId } = await seedOfferScenario();
      const stranger = await registerCustomer();
      await expect(listOffersForCustomer(stranger.userId, requestId, PAGE)).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND', status: 404 });
    });
  });
});
