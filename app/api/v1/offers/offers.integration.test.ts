import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { offerBody, seedOfferScenario, sendOffer, type ProviderFixture, type TestSession } from '@/lib/offers/offers-test-support';
import {
  authenticatedRequest,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  sessionGet,
} from '@/lib/matching/matching-test-support';
import { GET as GET_PROVIDER_INBOX } from '@/app/api/v1/providers/me/requests/route';
import { POST as CREATE } from './route';
import { GET as GET_ONE } from './[id]/route';
import { POST as ACCEPT } from './[id]/accept/route';
import { POST as DECLINE } from './[id]/decline/route';
import { POST as WITHDRAW } from './[id]/withdraw/route';
import { GET as LIST_FOR_REQUEST } from '../requests/[id]/offers/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

function post(url: string, session: TestSession, init?: { body?: unknown; idempotencyKey?: string | null }): Request {
  const req = authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'POST', body: init?.body });
  if (init?.idempotencyKey) req.headers.set('Idempotency-Key', init.idempotencyKey);
  return req;
}

async function createHttp(provider: ProviderFixture, body: unknown, key: string | null = randomUUID()) {
  return CREATE(post(`${BASE}/offers`, provider, { body, idempotencyKey: key }));
}

describe.skipIf(!dbReachable)('offer routes (spec 018 §3, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  describe('POST /offers', () => {
    it('201 on creation, 200 with the same offer on an identical replay', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const key = randomUUID();
      const created = await createHttp(providers[0]!, offerBody(requestId), key);
      expect(created.status).toBe(201);
      const { data } = await created.json();
      expect(data.status).toBe('sent');
      expect(data).not.toHaveProperty('idempotencyKey');
      expect(JSON.stringify(data)).not.toMatch(/idempotency|fingerprint/i);

      const replay = await createHttp(providers[0]!, offerBody(requestId), key);
      expect(replay.status).toBe(200);
      expect((await replay.json()).data.id).toBe(data.id);
    });

    it('400 VALIDATION_ERROR naming Idempotency-Key when the header is missing', async () => {
      const { providers, requestId } = await seedOfferScenario();
      const res = await createHttp(providers[0]!, offerBody(requestId), null);
      expect(res.status).toBe(400);
      expect((await res.json()).errors).toContainEqual(expect.objectContaining({ field: 'Idempotency-Key' }));
    });

    it('403 FORBIDDEN in customer mode, 403 CSRF_TOKEN_INVALID without CSRF, 401 without a session', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      expect((await createHttp(customer as unknown as ProviderFixture, offerBody(requestId))).status).toBe(403);

      const noCsrf = await CREATE(
        new Request(`${BASE}/offers`, {
          method: 'POST',
          headers: { cookie: `${SESSION_COOKIE_NAME}=${providers[0]!.sessionId}`, 'Idempotency-Key': randomUUID() },
          body: JSON.stringify(offerBody(requestId)),
        }),
      );
      expect(noCsrf.status).toBe(403);
      expect((await noCsrf.json()).code).toBe('CSRF_TOKEN_INVALID');

      const anonymous = await CREATE(new Request(`${BASE}/offers`, { method: 'POST', body: '{}' }));
      expect(anonymous.status).toBe(401);
    });

    it('403 NOT_DISTRIBUTED_TO_PROVIDER for a non-matched provider', async () => {
      const { requestId } = await seedOfferScenario();
      const outsider = await registerProvider();
      const res = await createHttp(outsider, offerBody(requestId));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('NOT_DISTRIBUTED_TO_PROVIDER');
    });

    it('409 LIVE_OFFER_EXISTS and 422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL map to their HTTP statuses', async () => {
      const quote = await seedOfferScenario();
      await createHttp(quote.providers[0]!, offerBody(quote.requestId));
      const dup = await createHttp(quote.providers[0]!, offerBody(quote.requestId));
      expect(dup.status).toBe(409);
      expect((await dup.json()).code).toBe('LIVE_OFFER_EXISTS');

      const fixed = await seedOfferScenario({ pricingModel: 'fixed' });
      const res = await createHttp(fixed.providers[0]!, offerBody(fixed.requestId));
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL');
    });

    it('429 RATE_LIMITED once the offers budget (30/min) is spent', async () => {
      const { providers, requestId } = await seedOfferScenario();
      let last: Response | undefined;
      for (let i = 0; i < 31; i += 1) last = await createHttp(providers[0]!, offerBody(requestId, { priceAmountMinorUnits: 'bad' }));
      expect(last!.status).toBe(429);
    });
  });

  describe('reads', () => {
    it('GET /requests/{id}/offers: owner sees every offer (paged); a stranger gets 404; a provider-mode caller 403', async () => {
      const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      await sendOffer(providers[0]!, requestId);
      await sendOffer(providers[1]!, requestId);

      const res = await LIST_FOR_REQUEST(sessionGet(`${BASE}/requests/${requestId}/offers`, customer));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.page).toMatchObject({ total: 2, offset: 0 });
      expect(body.data[0].serverNow).toBeTruthy();

      const stranger = await registerCustomer();
      const hidden = await LIST_FOR_REQUEST(sessionGet(`${BASE}/requests/${requestId}/offers`, stranger));
      expect(hidden.status).toBe(404);
      expect((await hidden.json()).code).toBe('REQUEST_NOT_FOUND');

      expect((await LIST_FOR_REQUEST(sessionGet(`${BASE}/requests/${requestId}/offers`, providers[0]!))).status).toBe(403);
    });

    it("GET /offers/{id}: the offer's provider and the request's customer can read it; others get 404", async () => {
      const { customer, providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      const offer = await sendOffer(providers[0]!, requestId);

      expect((await GET_ONE(sessionGet(`${BASE}/offers/${offer.id}`, providers[0]!))).status).toBe(200);
      const asCustomer = await GET_ONE(sessionGet(`${BASE}/offers/${offer.id}`, customer));
      expect(asCustomer.status).toBe(200);
      expect((await asCustomer.json()).data.status).toBe('viewed');

      const otherProvider = await GET_ONE(sessionGet(`${BASE}/offers/${offer.id}`, providers[1]!));
      expect(otherProvider.status).toBe(404);
      expect((await otherProvider.json()).code).toBe('OFFER_NOT_FOUND');
      expect((await GET_ONE(sessionGet(`${BASE}/offers/${randomUUID()}`, customer))).status).toBe(404);
    });

    it("the provider inbox exposes only the caller's own currentOffer, and send_offer again after withdrawal", async () => {
      const { providers, requestId } = await seedOfferScenario({ providerCount: 2 });
      const mine = await sendOffer(providers[0]!, requestId);
      await sendOffer(providers[1]!, requestId);

      const inbox = await (await GET_PROVIDER_INBOX(sessionGet(`${BASE}/providers/me/requests`, providers[0]!))).json();
      const item = inbox.data.find((r: { requestId: string }) => r.requestId === requestId);
      expect(item.currentOffer).toMatchObject({ offerId: mine.id, status: 'sent' });
      expect(item.availableAction).toBe('decline_only');

      await WITHDRAW(post(`${BASE}/offers/${mine.id}/withdraw`, providers[0]!));
      const after = await (await GET_PROVIDER_INBOX(sessionGet(`${BASE}/providers/me/requests`, providers[0]!))).json();
      const again = after.data.find((r: { requestId: string }) => r.requestId === requestId);
      expect(again.currentOffer.status).toBe('withdrawn');
      expect(again.availableAction).toBe('send_offer');
    });
  });

  describe('decisions over HTTP', () => {
    it('accept: 400 without Idempotency-Key, 200 with it, then 409 OFFER_ALREADY_DECIDED under a new key', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);

      expect((await ACCEPT(post(`${BASE}/offers/${offer.id}/accept`, customer))).status).toBe(400);
      const ok = await ACCEPT(post(`${BASE}/offers/${offer.id}/accept`, customer, { idempotencyKey: randomUUID() }));
      expect(ok.status).toBe(200);
      expect((await ok.json()).data.status).toBe('accepted');

      const again = await ACCEPT(post(`${BASE}/offers/${offer.id}/accept`, customer, { idempotencyKey: randomUUID() }));
      expect(again.status).toBe(409);
      expect((await again.json()).code).toBe('OFFER_ALREADY_DECIDED');
    });

    it('accept/decline require customer mode; withdraw requires provider mode', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      expect((await ACCEPT(post(`${BASE}/offers/${offer.id}/accept`, providers[0]!, { idempotencyKey: randomUUID() }))).status).toBe(403);
      expect((await DECLINE(post(`${BASE}/offers/${offer.id}/decline`, providers[0]!))).status).toBe(403);
      expect((await WITHDRAW(post(`${BASE}/offers/${offer.id}/withdraw`, customer))).status).toBe(403);
    });

    it('decline 200 then idempotent 200; a stranger customer gets 404', async () => {
      const { customer, providers, requestId } = await seedOfferScenario();
      const offer = await sendOffer(providers[0]!, requestId);
      const stranger = await registerCustomer();
      expect((await DECLINE(post(`${BASE}/offers/${offer.id}/decline`, stranger))).status).toBe(404);
      expect((await DECLINE(post(`${BASE}/offers/${offer.id}/decline`, customer))).status).toBe(200);
      expect((await DECLINE(post(`${BASE}/offers/${offer.id}/decline`, customer))).status).toBe(200);
    });
  });

  it('every spec 018 route is registered in the OpenAPI registry with its real path', () => {
    const registered = new Set(OPENAPI_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const key of [
      'POST /offers',
      'GET /offers/{id}',
      'POST /offers/{id}/accept',
      'POST /offers/{id}/decline',
      'POST /offers/{id}/withdraw',
      'GET /requests/{id}/offers',
    ]) {
      expect(registered.has(key)).toBe(true);
    }
  });
});
