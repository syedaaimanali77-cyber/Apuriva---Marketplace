import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { RATE_LIMIT_DEFAULTS } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetCompletionEvidenceGate } from '@/lib/bookings/completion-evidence';
import {
  authenticatedRequest,
  createBookingBody,
  driveToInProgress,
  isDatabaseReachable,
  seedBookingScenario,
  seedStranger,
  sessionGet,
  type BookingScenario,
  type TestSession,
} from '@/lib/bookings/bookings-test-support';
import { PATCH as SWITCH_MODE } from '@/app/api/v1/users/me/active-mode/route';
import { POST as CREATE_PROVIDER_PROFILE } from '@/app/api/v1/users/me/provider-profile/route';
import { GET as LIST, POST as CREATE } from './route';
import { GET as GET_ONE } from './[id]/route';
import { GET as GET_HISTORY } from './[id]/status-history/route';
import { POST as EN_ROUTE } from './[id]/provider-en-route/route';
import { POST as ARRIVED } from './[id]/arrived/route';
import { POST as START } from './[id]/start-service/route';
import { POST as COMPLETE } from './[id]/complete/route';

const dbReachable = await isDatabaseReachable();

/**
 * These suites build their fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker
 * threads that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect
 * that file already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;
const BASE = 'http://localhost/api/v1';

function post(url: string, session: TestSession, init?: { body?: unknown; idempotencyKey?: string | null }): Request {
  const req = authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'POST', body: init?.body });
  if (init?.idempotencyKey) req.headers.set('Idempotency-Key', init.idempotencyKey);
  return req;
}

/** A POST carrying the session cookie but NO CSRF header. */
function postWithoutCsrf(url: string, session: TestSession, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { cookie: `apuriva_session=${session.sessionId}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Switches the session's active mode through the real spec 006 route. */
async function switchMode(session: TestSession, mode: 'customer' | 'provider'): Promise<void> {
  await SWITCH_MODE(
    authenticatedRequest(`${BASE}/users/me/active-mode`, session.sessionId, session.csrfToken, {
      method: 'PATCH',
      body: { mode },
    }),
  );
}

async function createHttp(scenario: BookingScenario, body?: unknown, key: string | null = randomUUID()) {
  return CREATE(post(`${BASE}/bookings`, scenario.customer, { body: body ?? createBookingBody(scenario.offerId), idempotencyKey: key }));
}

async function createdBookingId(scenario: BookingScenario): Promise<string> {
  const res = await createHttp(scenario);
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

/** Spec 020 §3 — transport concerns: auth, active mode, CSRF, ownership, rate limiting, envelopes. */
describe.skipIf(!dbReachable)('booking routes (spec 020 §3, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    resetRateLimitState();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    resetCompletionEvidenceGate();
  });

  afterAll(async () => {
    await getPool().end();
  });

  describe('POST /bookings', () => {
    it('201 on creation, 200 with the same booking on an identical replay', async () => {
      const scenario = await seedBookingScenario();
      const key = randomUUID();

      const created = await createHttp(scenario, undefined, key);
      expect(created.status).toBe(201);
      const { data, correlationId } = await created.json();
      expect(correlationId).toBeTruthy();
      expect(data.status).toBe('confirmed');

      const replay = await createHttp(scenario, undefined, key);
      expect(replay.status).toBe(200);
      expect((await replay.json()).data.id).toBe(data.id);
    });

    /** §4 "Retention and privacy": idempotency data never reaches a client. */
    it('never exposes idempotency data or a counterparty user id', async () => {
      const scenario = await seedBookingScenario();
      const res = await createHttp(scenario);
      const body = JSON.stringify((await res.json()).data);

      expect(body).not.toMatch(/idempotency|fingerprint/i);
      expect(body).not.toContain(scenario.provider.userId);
      expect(body).not.toContain(scenario.customer.userId);
    });

    it('400 without an Idempotency-Key', async () => {
      const scenario = await seedBookingScenario();
      const res = await createHttp(scenario, undefined, null);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });

    it('403 CSRF_TOKEN_INVALID without the CSRF header', async () => {
      const scenario = await seedBookingScenario();
      const req = postWithoutCsrf(`${BASE}/bookings`, scenario.customer, createBookingBody(scenario.offerId));
      req.headers.set('Idempotency-Key', randomUUID());
      const res = await CREATE(req);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('401 without a session', async () => {
      const res = await CREATE(
        new Request(`${BASE}/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ offerId: randomUUID() }),
        }),
      );
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN in provider mode — creation is a customer action', async () => {
      const scenario = await seedBookingScenario();
      // The customer needs a provider profile of their own before the mode switch will take, which
      // is also the realistic dual-profile case §3's authorization matrix is written for.
      await CREATE_PROVIDER_PROFILE(
        authenticatedRequest(`${BASE}/users/me/provider-profile`, scenario.customer.sessionId, scenario.customer.csrfToken, {
          method: 'POST',
        }),
      );
      await switchMode(scenario.customer, 'provider');

      const res = await createHttp(scenario);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('FORBIDDEN');
    });

    it('404 OFFER_NOT_FOUND for another customer\'s offer, never 403', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const res = await CREATE(
        post(`${BASE}/bookings`, stranger.customer, {
          body: createBookingBody(scenario.offerId),
          idempotencyKey: randomUUID(),
        }),
      );
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('OFFER_NOT_FOUND');
    });

    it('429 once the bookings rate limit is exhausted', async () => {
      const scenario = await seedBookingScenario();
      // The limiter is checked BEFORE the body, the key and the offer are resolved, so the budget
      // can be exhausted with cheap rejected calls instead of 30 real bookings — much faster, and
      // it tests exactly the same thing.
      const budget = RATE_LIMIT_DEFAULTS.bookings.limit;
      for (let i = 0; i < budget; i += 1) {
        await CREATE(post(`${BASE}/bookings`, scenario.customer, { body: { offerId: randomUUID() }, idempotencyKey: randomUUID() }));
      }

      const res = await createHttp(scenario, undefined, randomUUID());
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  describe('GET /bookings/{id} and /status-history', () => {
    it('both participants can read the booking and its history, in either mode', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);

      const asCustomer = await GET_ONE(sessionGet(`${BASE}/bookings/${bookingId}`, scenario.customer));
      expect(asCustomer.status).toBe(200);

      const asProvider = await GET_ONE(sessionGet(`${BASE}/bookings/${bookingId}`, scenario.provider));
      expect(asProvider.status).toBe(200);
      expect((await asProvider.json()).data.id).toBe(bookingId);

      const history = await GET_HISTORY(sessionGet(`${BASE}/bookings/${bookingId}/status-history`, scenario.customer));
      expect(history.status).toBe(200);
      const rows = (await history.json()).data as { toStatus: string; actorRole: string }[];
      expect(rows.map((row) => row.toStatus)).toEqual(['pending', 'confirmed']);
      // §4: role only — a counterparty user id never reaches a client.
      expect(JSON.stringify(rows)).not.toContain(scenario.customer.userId);
    });

    it('404 for a non-participant and for an unknown id alike, so ids cannot be probed', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const bookingId = await createdBookingId(scenario);

      const asStranger = await GET_ONE(sessionGet(`${BASE}/bookings/${bookingId}`, stranger.customer));
      const unknown = await GET_ONE(sessionGet(`${BASE}/bookings/${randomUUID()}`, stranger.customer));
      expect(asStranger.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect((await asStranger.json()).code).toBe((await unknown.json()).code);
    });

    it('401 without a session', async () => {
      const res = await GET_ONE(new Request(`${BASE}/bookings/${randomUUID()}`));
      expect(res.status).toBe(401);
    });
  });

  describe('GET /bookings', () => {
    it('returns the caller\'s own bookings for their active mode, in the paged envelope', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);

      const asCustomer = await LIST(sessionGet(`${BASE}/bookings`, scenario.customer));
      expect(asCustomer.status).toBe(200);
      const customerBody = await asCustomer.json();
      expect(customerBody.page).toMatchObject({ limit: 20, offset: 0 });
      expect(customerBody.data.map((row: { id: string }) => row.id)).toContain(bookingId);

      const asProvider = await LIST(sessionGet(`${BASE}/bookings`, scenario.provider));
      expect((await asProvider.json()).data.map((row: { id: string }) => row.id)).toContain(bookingId);
    });

    it('never returns another user\'s bookings', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const bookingId = await createdBookingId(scenario);

      const res = await LIST(sessionGet(`${BASE}/bookings`, stranger.customer));
      expect((await res.json()).data.map((row: { id: string }) => row.id)).not.toContain(bookingId);
    });

    it('applies the documented filters', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);

      const upcoming = await LIST(sessionGet(`${BASE}/bookings?filter=upcoming`, scenario.customer));
      expect((await upcoming.json()).data.map((row: { id: string }) => row.id)).toContain(bookingId);

      const completed = await LIST(sessionGet(`${BASE}/bookings?filter=completed`, scenario.customer));
      expect((await completed.json()).data.map((row: { id: string }) => row.id)).not.toContain(bookingId);
    });
  });

  describe('provider lifecycle routes', () => {
    it('drive the booking through arrival and start, and reject the customer', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);

      const enRoute = await EN_ROUTE(post(`${BASE}/bookings/${bookingId}/provider-en-route`, scenario.provider));
      expect(enRoute.status).toBe(200);
      expect((await enRoute.json()).data.status).toBe('provider_en_route');

      const arrived = await ARRIVED(post(`${BASE}/bookings/${bookingId}/arrived`, scenario.provider));
      expect((await arrived.json()).data.status).toBe('arrived');

      const started = await START(post(`${BASE}/bookings/${bookingId}/start-service`, scenario.provider));
      expect((await started.json()).data.status).toBe('in_progress');

      // The customer is in customer mode, so a provider route is `403 FORBIDDEN`.
      const byCustomer = await ARRIVED(post(`${BASE}/bookings/${bookingId}/arrived`, scenario.customer));
      expect(byCustomer.status).toBe(403);
    });

    it('409 INVALID_STATUS_TRANSITION for an out-of-sequence action', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);

      const res = await START(post(`${BASE}/bookings/${bookingId}/start-service`, scenario.provider));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('INVALID_STATUS_TRANSITION');
      expect(body.details).toMatchObject({ currentStatus: 'confirmed' });
    });

    it('403 CSRF_TOKEN_INVALID without the CSRF header', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);
      const res = await ARRIVED(postWithoutCsrf(`${BASE}/bookings/${bookingId}/arrived`, scenario.provider));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('404 for a provider who does not own the booking', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const bookingId = await createdBookingId(scenario);

      const res = await ARRIVED(post(`${BASE}/bookings/${bookingId}/arrived`, stranger.provider));
      expect(res.status).toBe(404);
    });
  });

  describe('POST /bookings/{id}/complete', () => {
    it('accepts the provider and the customer alike — AC-8, no confirmation from the other party', async () => {
      const first = await seedBookingScenario();
      const firstId = await createdBookingId(first);
      await driveToInProgress(first, firstId);

      const byProvider = await COMPLETE(
        post(`${BASE}/bookings/${firstId}/complete`, first.provider, { idempotencyKey: randomUUID() }),
      );
      expect(byProvider.status).toBe(200);
      expect((await byProvider.json()).data.status).toBe('completed');

      const second = await seedBookingScenario();
      const secondId = await createdBookingId(second);
      await driveToInProgress(second, secondId);

      const byCustomer = await COMPLETE(
        post(`${BASE}/bookings/${secondId}/complete`, second.customer, { idempotencyKey: randomUUID() }),
      );
      expect(byCustomer.status).toBe(200);
      expect((await byCustomer.json()).data.status).toBe('completed');
    });

    it('400 without an Idempotency-Key', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);
      await driveToInProgress(scenario, bookingId);

      const res = await COMPLETE(post(`${BASE}/bookings/${bookingId}/complete`, scenario.customer, { idempotencyKey: null }));
      expect(res.status).toBe(400);
    });

    it('403 CSRF_TOKEN_INVALID without the CSRF header', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);
      await driveToInProgress(scenario, bookingId);

      const req = postWithoutCsrf(`${BASE}/bookings/${bookingId}/complete`, scenario.customer);
      req.headers.set('Idempotency-Key', randomUUID());
      expect((await COMPLETE(req)).status).toBe(403);
    });

    it('404 for a non-participant', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const bookingId = await createdBookingId(scenario);
      await driveToInProgress(scenario, bookingId);

      const res = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, stranger.customer, { idempotencyKey: randomUUID() }),
      );
      expect(res.status).toBe(404);
    });

    it('422 COMPLETION_TOO_EARLY before the dwell, with retryAfterSeconds', async () => {
      const scenario = await seedBookingScenario();
      const bookingId = await createdBookingId(scenario);
      await ARRIVED(post(`${BASE}/bookings/${bookingId}/arrived`, scenario.provider));
      await START(post(`${BASE}/bookings/${bookingId}/start-service`, scenario.provider));

      const res = await COMPLETE(
        post(`${BASE}/bookings/${bookingId}/complete`, scenario.customer, { idempotencyKey: randomUUID() }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('COMPLETION_TOO_EARLY');
      expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  /** §3 OpenAPI: `npm run check:openapi-drift` fails CI if a route is missing from the registry. */
  it('registers every spec 020 route in the OpenAPI registry under the bookings tag', () => {
    const expected: [string, string][] = [
      ['POST', '/bookings'],
      ['GET', '/bookings'],
      ['GET', '/bookings/{id}'],
      ['GET', '/bookings/{id}/status-history'],
      ['POST', '/bookings/{id}/provider-en-route'],
      ['POST', '/bookings/{id}/arrived'],
      ['POST', '/bookings/{id}/start-service'],
      ['POST', '/bookings/{id}/complete'],
    ];

    for (const [method, path] of expected) {
      const entry = OPENAPI_ROUTES.find((route) => route.method === method && route.path === path);
      expect(entry, `${method} ${path} missing from OPENAPI_ROUTES`).toBeDefined();
      expect(entry!.tags).toContain('bookings');
    }
  });
});
