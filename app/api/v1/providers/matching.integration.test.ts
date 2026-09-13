import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { runMatching } from '@/lib/matching/run';
import { GET as LIST_REQUESTS } from './me/requests/route';
import { GET as GET_REQUEST } from './me/requests/[id]/route';
import { POST as ACCEPT } from './me/requests/[id]/accept/route';
import { POST as DECLINE } from './me/requests/[id]/decline/route';
import {
  allWeekAlwaysOpen,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  seedCustomerWithAddress,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
  sessionGet,
  sessionMutate,
} from '@/lib/matching/matching-test-support';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

const dbReachable = await isDatabaseReachable();

async function seedDistributedRequest(pricingModel: 'fixed' | 'quote' = 'fixed') {
  const provider = await registerProvider();
  const { serviceId } = await seedProviderService(provider.providerProfileId);
  await getDb().update(services).set({ pricingModel }).where(eq(services.id, serviceId));
  await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
  const customer = await seedCustomerWithAddress();
  const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
  await runMatching(request.id);
  return { provider, serviceId, requestId: request.id };
}

describe.skipIf(!dbReachable)('provider incoming-requests + actions (spec 017 §3 AC-5, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('GET /providers/me/requests lists only requests this provider was distributed into', async () => {
    const { provider, requestId } = await seedDistributedRequest();
    const res = await LIST_REQUESTS(sessionGet('http://localhost/api/v1/providers/me/requests', provider));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: { requestId: string }) => r.requestId)).toContain(requestId);
  });

  it('GET /providers/me/requests requires provider mode', async () => {
    const customerOnly = await registerCustomer();
    const res = await LIST_REQUESTS(sessionGet('http://localhost/api/v1/providers/me/requests', customerOnly));
    expect(res.status).toBe(403);
  });

  it('GET /providers/me/requests/{id} returns the DTO with the correct availableAction for a fixed-price service', async () => {
    const { provider, requestId } = await seedDistributedRequest('fixed');
    const res = await GET_REQUEST(sessionGet(`http://localhost/api/v1/providers/me/requests/${requestId}`, provider));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.availableAction).toBe('accept');
    // Never carries score/rank/exclusion data — those are admin-only (AC-6).
    expect(data.score).toBeUndefined();
    expect(data.rank).toBeUndefined();
  });

  it('GET /providers/me/requests/{id} returns send_offer for a quote-priced service', async () => {
    const { provider, requestId } = await seedDistributedRequest('quote');
    const res = await GET_REQUEST(sessionGet(`http://localhost/api/v1/providers/me/requests/${requestId}`, provider));
    const { data } = await res.json();
    expect(data.availableAction).toBe('send_offer');
  });

  it('GET .../{id} for a request never distributed to this provider is 403 NOT_DISTRIBUTED_TO_PROVIDER', async () => {
    const { requestId } = await seedDistributedRequest();
    const outsider = await registerProvider();
    const res = await GET_REQUEST(sessionGet(`http://localhost/api/v1/providers/me/requests/${requestId}`, outsider));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('NOT_DISTRIBUTED_TO_PROVIDER');
  });

  it('POST .../accept succeeds for a fixed-price service and returns the response DTO', async () => {
    const { provider, requestId } = await seedDistributedRequest('fixed');
    const res = await ACCEPT(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, provider, 'POST'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.providerResponse).toBe('accepted');
  });

  it('POST .../accept on a quote-priced service is 422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL', async () => {
    const { provider, requestId } = await seedDistributedRequest('quote');
    const res = await ACCEPT(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, provider, 'POST'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL');
  });

  it('POST .../accept for a provider not distributed into the request is 403', async () => {
    const { requestId } = await seedDistributedRequest('fixed');
    const outsider = await registerProvider();
    const res = await ACCEPT(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, outsider, 'POST'));
    expect(res.status).toBe(403);
  });

  it('repeating the same accept is idempotent — 200 with the existing response', async () => {
    const { provider, requestId } = await seedDistributedRequest('fixed');
    const first = await ACCEPT(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, provider, 'POST'));
    const second = await ACCEPT(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, provider, 'POST'));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('POST .../decline is always available for a distributed provider, regardless of pricing model', async () => {
    const { provider, requestId } = await seedDistributedRequest('quote');
    const res = await DECLINE(sessionMutate(`http://localhost/api/v1/providers/me/requests/${requestId}/decline`, provider, 'POST'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.providerResponse).toBe('declined');
  });

  it('accept requires CSRF — a mutating call without the CSRF header is rejected', async () => {
    const { provider, requestId } = await seedDistributedRequest('fixed');
    const res = await ACCEPT(
      new Request(`http://localhost/api/v1/providers/me/requests/${requestId}/accept`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${provider.sessionId}` },
      }),
    );
    expect(res.status).toBe(403);
  });
});
