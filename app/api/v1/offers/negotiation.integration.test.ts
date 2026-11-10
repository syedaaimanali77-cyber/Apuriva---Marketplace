import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import {
  authenticatedRequest,
  isDatabaseReachable,
  offerBody,
  reviseBody,
  seedOfferScenario,
  seedOffersFromEachProvider,
  sessionGet,
  type TestSession,
} from '@/lib/negotiation/negotiation-test-support';
import { POST as CREATE_OFFER } from './route';
import { POST as CREATE_CHANGE_REQUEST } from './[id]/change-requests/route';
import { GET as GET_REVISIONS, POST as CREATE_REVISION } from './[id]/revisions/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

function post(url: string, session: TestSession, body: unknown, key: string | null = randomUUID()): Request {
  const req = authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'POST', body });
  if (key) req.headers.set('Idempotency-Key', key);
  return req;
}

/** Spec 019 §3 — the offer-scoped negotiation routes: change requests and revisions. */
describe.skipIf(!dbReachable)('offer negotiation routes (spec 019 §3, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('every spec 019 offer route is registered in the OpenAPI registry, and spec 018 summaries mention OFFER_SUPERSEDED', () => {
    const registered = new Set(OPENAPI_ROUTES.map((r) => `${r.method} ${r.path}`));
    expect(registered).toContain('POST /offers/{id}/change-requests');
    expect(registered).toContain('POST /offers/{id}/revisions');
    expect(registered).toContain('GET /offers/{id}/revisions');
    for (const path of ['/offers/{id}/accept', '/offers/{id}/decline', '/offers/{id}/withdraw']) {
      expect(OPENAPI_ROUTES.find((r) => r.path === path)!.summary).toMatch(/OFFER_SUPERSEDED/);
    }
  });

  it('201 on a change request, 200 on an identical replay, 409 on a second change request', async () => {
    const { customer, offerIds } = await seedOffersFromEachProvider(1);
    const url = `${BASE}/offers/${offerIds[0]}/change-requests`;
    const key = randomUUID();

    const created = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'Sunday instead?', proposedPriceAmountMinorUnits: 250_000 }, key));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data).toMatchObject({ kind: 'change_request', offerId: offerIds[0], proposedPrice: { amountMinorUnits: 250_000, currencyCode: 'PKR' } });

    const replay = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'Sunday instead?', proposedPriceAmountMinorUnits: 250_000 }, key));
    expect(replay.status).toBe(200);

    const second = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'Another' }));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('CHANGE_ALREADY_REQUESTED');
  });

  it('change requests: 401, 403 CSRF, 403 wrong mode, 400 without Idempotency-Key, 404 for another customer', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const outsider = await seedOfferScenario();
    const url = `${BASE}/offers/${offerIds[0]}/change-requests`;

    expect((await CREATE_CHANGE_REQUEST(new Request(url, { method: 'POST', body: '{}' }))).status).toBe(401);

    const noCsrf = await CREATE_CHANGE_REQUEST(
      new Request(url, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${customer.sessionId}`, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ note: 'x' }),
      }),
    );
    expect((await noCsrf.json()).code).toBe('CSRF_TOKEN_INVALID');

    const providerMode = await CREATE_CHANGE_REQUEST(post(url, providers[0]!, { note: 'x' }));
    expect(providerMode.status).toBe(403);

    const noKey = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'x' }, null));
    expect(noKey.status).toBe(400);

    const otherCustomer = await CREATE_CHANGE_REQUEST(post(url, outsider.customer, { note: 'x' }));
    expect(otherCustomer.status).toBe(404);
    expect((await otherCustomer.json()).code).toBe('OFFER_NOT_FOUND');
  });

  it('201 on a revision returning the NEW offer, 200 on replay, and the chain is readable by both parties', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const url = `${BASE}/offers/${offerIds[0]}/revisions`;
    const key = randomUUID();

    const created = await CREATE_REVISION(post(url, provider, reviseBody({ priceAmountMinorUnits: 270_000 }), key));
    expect(created.status).toBe(201);
    const { data: revised } = await created.json();
    expect(revised.id).not.toBe(offerIds[0]);
    expect(revised).toMatchObject({ status: 'sent', priceAmountMinorUnits: 270_000, revisionNumber: 1, previousOfferId: offerIds[0] });

    const replay = await CREATE_REVISION(post(url, provider, reviseBody({ priceAmountMinorUnits: 270_000 }), key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(revised.id);

    const asProvider = await GET_REVISIONS(sessionGet(`${BASE}/offers/${revised.id}/revisions`, provider));
    expect(asProvider.status).toBe(200);
    const providerChain = (await asProvider.json()).data;
    expect(providerChain).toHaveLength(1);
    expect(providerChain[0]).toMatchObject({
      previousOfferId: offerIds[0],
      offerId: revised.id,
      revisionNumber: 1,
      previousPrice: { amountMinorUnits: 300_000, currencyCode: 'PKR' },
      newPrice: { amountMinorUnits: 270_000, currencyCode: 'PKR' },
      actorRole: 'provider',
    });
    expect(JSON.stringify(providerChain)).not.toContain(provider.userId);

    const asCustomer = await GET_REVISIONS(sessionGet(`${BASE}/offers/${revised.id}/revisions`, customer));
    expect(asCustomer.status).toBe(200);
    expect((await asCustomer.json()).data).toHaveLength(1);
  });

  it('revisions: 403 in customer mode, 400 without Idempotency-Key, 404 for another provider’s offer', async () => {
    const { customer, providers, offerIds } = await seedOffersFromEachProvider(1);
    const outsider = await seedOfferScenario();
    const url = `${BASE}/offers/${offerIds[0]}/revisions`;

    const customerMode = await CREATE_REVISION(post(url, customer, reviseBody()));
    expect(customerMode.status).toBe(403);
    expect((await customerMode.json()).code).toBe('FORBIDDEN');

    const noKey = await CREATE_REVISION(post(url, providers[0]!, reviseBody(), null));
    expect(noKey.status).toBe(400);

    const otherProvider = await CREATE_REVISION(post(url, outsider.providers[0]!, reviseBody()));
    expect(otherProvider.status).toBe(404);
    expect((await otherProvider.json()).code).toBe('OFFER_NOT_FOUND');

    const chainProbe = await GET_REVISIONS(sessionGet(`${BASE}/offers/${offerIds[0]}/revisions`, outsider.customer));
    expect(chainProbe.status).toBe(404);
  });

  it('409 OFFER_SUPERSEDED carries the current offer id', async () => {
    const { providers, offerIds } = await seedOffersFromEachProvider(1);
    const provider = providers[0]!;
    const first = await CREATE_REVISION(post(`${BASE}/offers/${offerIds[0]}/revisions`, provider, reviseBody({ priceAmountMinorUnits: 280_000 })));
    const head = (await first.json()).data;

    const stale = await CREATE_REVISION(post(`${BASE}/offers/${offerIds[0]}/revisions`, provider, reviseBody({ priceAmountMinorUnits: 260_000 })));
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe('OFFER_SUPERSEDED');
    expect(body.details).toEqual({ currentOfferId: head.id });
  });

  it('POST /offers redacts providerMessage and includedItems while an idempotent replay still matches', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;
    const key = randomUUID();
    const body = offerBody(requestId, {
      providerMessage: 'WhatsApp me on 0300 123 4567',
      includedItems: ['Labour', 'Email ali@example.com'],
    });

    const created = await CREATE_OFFER(post(`${BASE}/offers`, provider, body, key));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data.providerMessage).not.toContain('0300');
    expect(data.providerMessage).toContain('[contact removed]');
    expect(data.includedItems[1]).not.toContain('ali@example.com');

    // The fingerprint covers the RAW body, so redaction never breaks a replay.
    const replay = await CREATE_OFFER(post(`${BASE}/offers`, provider, body, key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(data.id);
  });

  it('the offers rate-limit domain covers change requests and revisions', async () => {
    const { customer, offerIds } = await seedOffersFromEachProvider(1);
    const url = `${BASE}/offers/${offerIds[0]}/change-requests`;

    // The `offers` domain allows 30 writes per minute per user.
    let last = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'x' }));
    for (let i = 0; i < 31 && last.status !== 429; i += 1) last = await CREATE_CHANGE_REQUEST(post(url, customer, { note: 'x' }));
    expect(last.status).toBe(429);
    expect(last.headers.get('Retry-After')).not.toBeNull();
  });
});
