import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import {
  authenticatedRequest,
  isDatabaseReachable,
  registerProvider,
  seedOfferScenario,
  sessionGet,
  type ProviderFixture,
} from '@/lib/negotiation/negotiation-test-support';
import { GET as GET_MESSAGES, POST as POST_MESSAGE } from './me/requests/[id]/messages/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

function url(requestId: string): string {
  return `${BASE}/providers/me/requests/${requestId}/messages`;
}

function post(requestId: string, provider: ProviderFixture, body: unknown, key: string | null = randomUUID()): Request {
  const req = authenticatedRequest(url(requestId), provider.sessionId, provider.csrfToken, { method: 'POST', body });
  if (key) req.headers.set('Idempotency-Key', key);
  return req;
}

/** Spec 019 §3 — the provider side of a pre-selection thread. */
describe.skipIf(!dbReachable)('provider negotiation messages (spec 019 §3, integration)', { timeout: 60_000 }, () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('both provider message routes are registered in the OpenAPI registry', () => {
    const registered = new Set(OPENAPI_ROUTES.map((r) => `${r.method} ${r.path}`));
    expect(registered).toContain('GET /providers/me/requests/{id}/messages');
    expect(registered).toContain('POST /providers/me/requests/{id}/messages');
  });

  it('a distributed provider can post before sending any offer, and read the thread back', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;

    const created = await POST_MESSAGE(post(requestId, provider, { body: 'Which floor is the unit on?' }));
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data).toMatchObject({ senderRole: 'provider', kind: 'message', requestId, providerProfileId: provider.providerProfileId });

    const list = await GET_MESSAGES(sessionGet(url(requestId), provider));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data.map((m: { body: string }) => m.body)).toEqual(['Which floor is the unit on?']);
    expect(JSON.stringify(body.data)).not.toContain(provider.userId);
  });

  it('403 NOT_DISTRIBUTED_TO_PROVIDER for a request the provider was never distributed into, and for an unknown id', async () => {
    const { requestId } = await seedOfferScenario();
    const outsider = await registerProvider();

    const post403 = await POST_MESSAGE(post(requestId, outsider, { body: 'hi' }));
    expect(post403.status).toBe(403);
    expect((await post403.json()).code).toBe('NOT_DISTRIBUTED_TO_PROVIDER');

    const unknown = await GET_MESSAGES(sessionGet(url(randomUUID()), outsider));
    expect(unknown.status).toBe(403);
    const malformed = await GET_MESSAGES(sessionGet(url('not-a-uuid'), outsider));
    expect(malformed.status).toBe(403);
  });

  it('401 without a session, 403 CSRF_TOKEN_INVALID without the CSRF header, 403 FORBIDDEN in customer mode, 400 without Idempotency-Key', async () => {
    const { customer, providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;

    expect((await POST_MESSAGE(new Request(url(requestId), { method: 'POST', body: '{}' }))).status).toBe(401);

    const noCsrf = await POST_MESSAGE(
      new Request(url(requestId), {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${provider.sessionId}`, 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ body: 'hi' }),
      }),
    );
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).code).toBe('CSRF_TOKEN_INVALID');

    const customerMode = await POST_MESSAGE(
      authenticatedRequest(url(requestId), customer.sessionId, customer.csrfToken, { method: 'POST', body: { body: 'hi' } }),
    );
    expect(customerMode.status).toBe(403);
    expect((await customerMode.json()).code).toBe('FORBIDDEN');

    const noKey = await POST_MESSAGE(post(requestId, provider, { body: 'hi' }, null));
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).errors).toContainEqual(expect.objectContaining({ field: 'Idempotency-Key' }));
  });

  it('uses the messaging rate-limit domain', async () => {
    const { providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;

    let last = await GET_MESSAGES(sessionGet(url(requestId), provider));
    for (let i = 0; i < 30 && last.status === 200; i += 1) last = await GET_MESSAGES(sessionGet(url(requestId), provider));
    expect(last.status).toBe(429);
    expect(last.headers.get('Retry-After')).not.toBeNull();
  });
});
