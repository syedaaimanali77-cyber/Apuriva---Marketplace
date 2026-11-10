import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as LIST_REQUESTS, POST as CREATE_REQUEST } from './route';
import { GET as GET_REQUEST } from './[id]/route';
import {
  createRequestHttp,
  isDatabaseReachable,
  registerCustomerWithAddress,
  seedPublishedService,
  validRequestBody,
  type TestSession,
} from './requests-test-support';

const dbReachable = await isDatabaseReachable();

function authedGet(session: TestSession, url: string): Request {
  return new Request(url, { method: 'GET', headers: { cookie: `apuriva_session=${session.sessionId}` } });
}

async function createSubmittedRequest() {
  const customer = await registerCustomerWithAddress();
  const service = await seedPublishedService();
  const res = await CREATE_REQUEST(createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId)));
  return { customer, request: (await res.json()).data };
}

describe.skipIf(!dbReachable)('request reads (spec 015 AC-5 + ownership, integration)', () => {
  it('AC-5: returns the customer-facing step and no internal matching mechanics', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();

    const res = await GET_REQUEST(authedGet(customer, `http://localhost/api/v1/requests/${request.id}`));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.customerFacingStep).toBe('Request sent');
    const serialized = JSON.stringify(data);
    for (const leak of ['providerProfileId', 'matches', 'rank', 'score', 'excluded', 'pool', 'customerProfileId']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('another customer cannot read the request — 404, indistinguishable from not existing', async () => {
    resetRateLimitState();
    const { request } = await createSubmittedRequest();
    const stranger = await registerCustomerWithAddress();

    const mine = await GET_REQUEST(authedGet(stranger, `http://localhost/api/v1/requests/${request.id}`));
    expect(mine.status).toBe(404);
    expect((await mine.json()).code).toBe('REQUEST_NOT_FOUND');

    const missing = await GET_REQUEST(authedGet(stranger, `http://localhost/api/v1/requests/${randomUUID()}`));
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('REQUEST_NOT_FOUND');
  });

  it('the list is scoped to the caller and defaults to active requests', async () => {
    resetRateLimitState();
    const { customer, request } = await createSubmittedRequest();
    await createSubmittedRequest(); // a different customer's request

    const res = await LIST_REQUESTS(authedGet(customer, 'http://localhost/api/v1/requests'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.map((r: { id: string }) => r.id)).toEqual([request.id]);
    expect(body.page).toMatchObject({ limit: 20, offset: 0, total: 1 });
    expect(body.data[0].customerFacingStep).toBe('Request sent');
  });

  it('filter=history excludes in-flight requests', async () => {
    resetRateLimitState();
    const { customer } = await createSubmittedRequest();

    const res = await LIST_REQUESTS(authedGet(customer, 'http://localhost/api/v1/requests?filter=history'));
    expect((await res.json()).data).toEqual([]);
  });

  it('rejects an unauthenticated read', async () => {
    resetRateLimitState();
    const res = await LIST_REQUESTS(new Request('http://localhost/api/v1/requests', { method: 'GET' }));
    expect(res.status).toBe(401);
  });
});
