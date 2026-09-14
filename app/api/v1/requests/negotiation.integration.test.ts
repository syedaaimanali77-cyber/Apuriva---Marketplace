import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import {
  authenticatedRequest,
  isDatabaseReachable,
  seedOfferScenario,
  seedOffersFromEachProvider,
  sessionGet,
  type TestSession,
} from '@/lib/negotiation/negotiation-test-support';
import { GET as GET_THREADS } from './[id]/message-threads/route';
import { GET as GET_MESSAGES, POST as POST_MESSAGE } from './[id]/message-threads/[providerProfileId]/messages/route';
import { GET as GET_COMPARE } from './[id]/offers/compare/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

function threadUrl(requestId: string, providerProfileId: string): string {
  return `${BASE}/requests/${requestId}/message-threads/${providerProfileId}/messages`;
}

function post(url: string, session: TestSession, body: unknown, idempotencyKey: string | null = randomUUID()): Request {
  const req = authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'POST', body });
  if (idempotencyKey) req.headers.set('Idempotency-Key', idempotencyKey);
  return req;
}

/** Spec 019 §3 — the customer-facing negotiation routes: threads, messages and comparison. */
describe.skipIf(!dbReachable)('customer negotiation routes (spec 019 §3, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('every spec 019 customer route is registered in the OpenAPI registry', () => {
    const registered = new Set(OPENAPI_ROUTES.map((r) => `${r.method} ${r.path}`));
    expect(registered).toContain('GET /requests/{id}/message-threads');
    expect(registered).toContain('GET /requests/{id}/message-threads/{providerProfileId}/messages');
    expect(registered).toContain('POST /requests/{id}/message-threads/{providerProfileId}/messages');
    expect(registered).toContain('GET /requests/{id}/offers/compare');
    for (const entry of OPENAPI_ROUTES.filter((r) => r.tags.includes('negotiation'))) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('201 on a posted message, 200 on an identical replay, and the DTO carries senderRole but never a user id, name, phone or email', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const url = threadUrl(requestId, providers[0]!.providerProfileId);
    const key = randomUUID();

    const created = await POST_MESSAGE(post(url, customer, { body: 'Is the AC on the second floor? Call 03001234567' }, key));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data).toMatchObject({ senderRole: 'customer', kind: 'message', contactRedacted: true });
    expect(data.body).not.toContain('03001234567');
    expect(JSON.stringify(data)).not.toContain(customer.userId);
    expect(JSON.stringify(data)).not.toMatch(/idempotency|fingerprint|senderUserId/i);

    const replay = await POST_MESSAGE(post(url, customer, { body: 'Is the AC on the second floor? Call 03001234567' }, key));
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(data.id);
  });

  it('400 VALIDATION_ERROR naming Idempotency-Key when the header is missing, and for an invalid body', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const url = threadUrl(requestId, providers[0]!.providerProfileId);

    const noKey = await POST_MESSAGE(post(url, customer, { body: 'hello' }, null));
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).errors).toContainEqual(expect.objectContaining({ field: 'Idempotency-Key' }));

    const badBody = await POST_MESSAGE(post(url, customer, { body: '' }));
    expect(badBody.status).toBe(400);
    expect((await badBody.json()).errors).toContainEqual(expect.objectContaining({ field: 'body' }));
  });

  it('401 without a session, 403 CSRF_TOKEN_INVALID without the CSRF header, 403 FORBIDDEN in provider mode', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const url = threadUrl(requestId, providers[0]!.providerProfileId);

    const anonymous = await POST_MESSAGE(new Request(url, { method: 'POST', body: JSON.stringify({ body: 'hi' }) }));
    expect(anonymous.status).toBe(401);

    const noCsrf = await POST_MESSAGE(
      new Request(url, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${customer.sessionId}`, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ body: 'hi' }),
      }),
    );
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).code).toBe('CSRF_TOKEN_INVALID');

    // A provider-mode session cannot use the customer thread route.
    const wrongMode = await POST_MESSAGE(post(url, providers[0]!, { body: 'hi' }));
    expect(wrongMode.status).toBe(403);
    expect((await wrongMode.json()).code).toBe('FORBIDDEN');
  });

  it('404 for another customer’s request and for an invisible thread — ids cannot be probed', async () => {
    const { providers, requestId } = await seedOffersFromEachProvider(1);
    const outsider = await seedOfferScenario();

    const otherCustomer = await GET_MESSAGES(sessionGet(threadUrl(requestId, providers[0]!.providerProfileId), outsider.customer));
    expect(otherCustomer.status).toBe(404);
    expect((await otherCustomer.json()).code).toBe('REQUEST_NOT_FOUND');

    const unknownProvider = await GET_MESSAGES(sessionGet(threadUrl(requestId, randomUUID()), outsider.customer));
    expect(unknownProvider.status).toBe(404);
  });

  it('lists threads for the owning customer only', async () => {
    const { customer, requestId } = await seedOffersFromEachProvider(2);
    const res = await GET_THREADS(sessionGet(`${BASE}/requests/${requestId}/message-threads`, customer));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.page).toMatchObject({ total: 2, limit: expect.any(Number), offset: 0 });
    expect(JSON.stringify(body.data)).not.toContain(customer.userId);
  });

  it('message routes use the messaging rate-limit domain', async () => {
    const { customer, providers, requestId } = await seedOffersFromEachProvider(1);
    const url = threadUrl(requestId, providers[0]!.providerProfileId);

    // The `messaging` domain allows 30 requests per minute per user.
    let last = await GET_MESSAGES(sessionGet(url, customer));
    for (let i = 0; i < 30 && last.status === 200; i += 1) last = await GET_MESSAGES(sessionGet(url, customer));
    expect(last.status).toBe(429);
    expect(last.headers.get('Retry-After')).not.toBeNull();

    // The comparison route is on the separate `offers` budget, so it still answers.
    const compare = await GET_COMPARE(sessionGet(`${BASE}/requests/${requestId}/offers/compare`, customer));
    expect(compare.status).toBe(200);
  });

  it('comparison returns the envelope with no score, weight, breakdown, rank number or exclusion reason', async () => {
    const { customer, requestId } = await seedOffersFromEachProvider(2);
    const res = await GET_COMPARE(sessionGet(`${BASE}/requests/${requestId}/offers/compare`, customer));

    expect(res.status).toBe(200);
    const { data, correlationId } = await res.json();
    expect(correlationId).toEqual(expect.any(String));
    expect(data).toMatchObject({ requestId, available: true, unavailableReason: null, maxOffers: 3 });
    expect(data.offers).toHaveLength(2);
    expect(JSON.stringify(data)).not.toMatch(/scoreMicros|scoreBreakdown|normalized|weight|exclusionReason|"rank"/i);
  });

  it('comparison answers 200 available:false rather than an error when it is unavailable, and 422 for too many ids', async () => {
    const single = await seedOffersFromEachProvider(1);
    const unavailable = await GET_COMPARE(sessionGet(`${BASE}/requests/${single.requestId}/offers/compare`, single.customer));
    expect(unavailable.status).toBe(200);
    expect((await unavailable.json()).data).toMatchObject({ available: false, unavailableReason: 'fewer_than_two_comparable_offers' });

    const many = await seedOffersFromEachProvider(4);
    const tooMany = await GET_COMPARE(
      sessionGet(`${BASE}/requests/${many.requestId}/offers/compare?offerIds=${many.offerIds.join(',')}`, many.customer),
    );
    expect(tooMany.status).toBe(422);
    expect((await tooMany.json()).code).toBe('COMPARISON_LIMIT_EXCEEDED');
  });
});
