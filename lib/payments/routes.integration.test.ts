import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { RATE_LIMIT_DEFAULTS } from '@/lib/api/rate-limit';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { POST as AUTHORIZE } from '@/app/api/v1/bookings/[id]/payment/authorize/route';
import { POST as CAPTURE } from '@/app/api/v1/bookings/[id]/payment/capture/route';
import { GET as READ_PAYMENT } from '@/app/api/v1/bookings/[id]/payment/route';
import { GET as LIST_ADJUSTMENTS, POST as PROPOSE } from '@/app/api/v1/bookings/[id]/price-adjustments/route';
import { POST as APPROVE } from '@/app/api/v1/price-adjustments/[id]/approve/route';
import { POST as REJECT } from '@/app/api/v1/price-adjustments/[id]/reject/route';
import { GET as SWEEP } from '@/app/api/v1/cron/payment-sweep/route';
import type { NextRequest } from 'next/server';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  seedStranger,
  sessionGet,
  sessionMutate,
  storedPayment,
  usePaymentIntegration,
  type BookingScenario,
} from './payments-test-support';
import { PAYMENT_PROVIDER_ENV_VAR } from './provider';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

const BASE = 'http://localhost/api/v1';

function keyed(request: Request, key = freshKey()): Request {
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', key);
  return new Request(request, { headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function pendingBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  return booking.id;
}

describe.skipIf(!dbReachable)('payment routes (spec 021 §3 "Endpoints")', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** The happy path through the real handler, with the real guard sequence in front of it. */
  it('authorizes, reads back, and confirms the booking', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const authorize = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')),
    );
    expect(authorize.status).toBe(200);
    expect((await body(authorize)).data).toMatchObject({ status: 'captured', bookingId });

    const read = await READ_PAYMENT(sessionGet(`${BASE}/bookings/${bookingId}/payment`, scenario.customer));
    expect(read.status).toBe(200);
    const payment = (await body(read)).data as Record<string, unknown>;
    // §4 "Retention and privacy": nothing provider-facing is ever serialized to a client.
    expect(payment).not.toHaveProperty('providerReference');
    expect(payment).not.toHaveProperty('providerName');
    expect(JSON.stringify(payment)).not.toMatch(/sandbox_/);
  });

  /** Step 1 of the normative guard order. */
  it('requires a session', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const response = await AUTHORIZE(
      keyed(new Request(`${BASE}/bookings/${bookingId}/payment/authorize`, { method: 'POST' })),
    );
    expect(response.status).toBe(401);
  });

  /** Step 2 — CSRF on every mutating browser route. */
  it('requires a CSRF token on every mutation', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const noCsrf = new Request(`${BASE}/bookings/${bookingId}/payment/authorize`, {
      method: 'POST',
      headers: { cookie: `apuriva_session=${scenario.customer.sessionId}`, 'Idempotency-Key': freshKey() },
    });
    const response = await AUTHORIZE(noCsrf);
    expect(response.status).toBe(403);
    expect((await body(response)).code).toBe('CSRF_TOKEN_INVALID');
  });

  /** Step 3 — the active mode selects who the caller is acting as, and is never inferred. */
  it('requires customer mode to authorize, and provider mode to propose', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const wrongMode = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.provider, 'POST')),
    );
    expect(wrongMode.status).toBe(403);

    const customerProposing = await PROPOSE(
      keyed(
        sessionMutate(`${BASE}/bookings/${bookingId}/price-adjustments`, scenario.customer, 'POST', {
          additionalAmountMinorUnits: 45_000,
          additionalCurrencyCode: 'PKR',
          reason: 'nope',
        }),
      ),
    );
    expect(customerProposing.status).toBe(403);
  });

  /** Step 5 — the key is mandatory, and its absence is a field-level validation error. */
  it('requires an Idempotency-Key on every mutation', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const response = await AUTHORIZE(
      sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST'),
    );
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.errors).toMatchObject([{ field: 'Idempotency-Key' }]);
  });

  /** A stranger gets `404`, never `403`: booking ids must not be probeable. */
  it('hides a booking from a non-participant behind 404, never 403', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    const stranger = await seedStranger();

    const authorize = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, stranger.customer, 'POST')),
    );
    expect(authorize.status).toBe(404);

    const read = await READ_PAYMENT(sessionGet(`${BASE}/bookings/${bookingId}/payment`, stranger.customer));
    expect(read.status).toBe(404);
  });

  /** AC-6 at the transport layer: the §105 wording is what the API itself returns. */
  it('returns 422 PAYMENT_FAILED with the §105 wording on a decline', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 321_102 });
    const bookingId = await pendingBooking(scenario);

    const response = await AUTHORIZE(
      keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')),
    );
    expect(response.status).toBe(422);
    const payload = await body(response);
    expect(payload.code).toBe('PAYMENT_FAILED');
    expect(payload.message).toBe("Payment wasn't completed. No charge was confirmed.");
  });

  /** AC-10 at the transport layer — an unusable adapter is 503, never a 500 and never a success. */
  it('answers 503 PAYMENT_PROVIDER_UNAVAILABLE when no adapter resolves', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const original = process.env[PAYMENT_PROVIDER_ENV_VAR];
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'no-such-adapter';
    try {
      const response = await AUTHORIZE(
        keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')),
      );
      expect(response.status).toBe(503);
      expect((await body(response)).code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    } finally {
      process.env[PAYMENT_PROVIDER_ENV_VAR] = original;
    }

    // Nothing was written: a booking cannot be half-paid by an unusable adapter.
    expect(await storedPayment(bookingId)).toBeUndefined();
  });

  /** The full adjustment round trip through the real routes, in the modes each one demands. */
  it('drives a price adjustment from proposal to approval through the routes', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await AUTHORIZE(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')));

    const proposed = await PROPOSE(
      keyed(
        sessionMutate(`${BASE}/bookings/${bookingId}/price-adjustments`, scenario.provider, 'POST', {
          additionalAmountMinorUnits: 45_000,
          additionalCurrencyCode: 'PKR',
          reason: 'Replacement part',
        }),
      ),
    );
    expect(proposed.status).toBe(201);
    const adjustment = (await body(proposed)).data as { id: string; status: string };
    expect(adjustment.status).toBe('pending_approval');

    const listed = await LIST_ADJUSTMENTS(sessionGet(`${BASE}/bookings/${bookingId}/price-adjustments`, scenario.customer));
    expect(listed.status).toBe(200);
    expect((await body(listed)).data).toHaveLength(1);

    const approved = await APPROVE(
      keyed(sessionMutate(`${BASE}/price-adjustments/${adjustment.id}/approve`, scenario.customer, 'POST')),
    );
    expect(approved.status).toBe(200);
    expect((await body(approved)).data).toMatchObject({ status: 'charged' });
  });

  it('lets the customer decline a proposed adjustment', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await AUTHORIZE(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')));

    const proposed = await PROPOSE(
      keyed(
        sessionMutate(`${BASE}/bookings/${bookingId}/price-adjustments`, scenario.provider, 'POST', {
          additionalAmountMinorUnits: 45_000,
          additionalCurrencyCode: 'PKR',
          reason: 'Extra time',
        }),
      ),
    );
    const adjustment = (await body(proposed)).data as { id: string };

    const rejected = await REJECT(
      keyed(sessionMutate(`${BASE}/price-adjustments/${adjustment.id}/reject`, scenario.customer, 'POST')),
    );
    expect(rejected.status).toBe(200);
    expect((await body(rejected)).data).toMatchObject({ status: 'rejected' });
  });

  it('answers 409 PAYMENT_ALREADY_CAPTURED on a duplicate capture under a new key', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await AUTHORIZE(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/authorize`, scenario.customer, 'POST')));

    const response = await CAPTURE(
      keyed(sessionMutate(`${BASE}/bookings/${bookingId}/payment/capture`, scenario.customer, 'POST')),
    );
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe('PAYMENT_ALREADY_CAPTURED');
  });

  /** Step 4 — the sweep is not a browser route: it is bearer-authenticated like every other cron. */
  it('refuses the sweep without the cron secret', async () => {
    const response = await SWEEP(new Request(`${BASE}/cron/payment-sweep`) as NextRequest);
    expect(response.status).toBe(401);
  });

  it('runs the sweep with the cron secret', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const response = await SWEEP(
        new Request(`${BASE}/cron/payment-sweep`, { headers: { authorization: 'Bearer test-cron-secret' } }) as NextRequest,
      );
      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({ status: 'ok' });
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });
});

/** §3 — contract registration, checkable without a database. */
describe('payment route registration (spec 021 §3)', () => {
  const registered = OPENAPI_ROUTES.filter((route) => route.tags.includes('payments'));

  it('registers every payment route in OPENAPI_ROUTES', () => {
    expect(registered.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /bookings/{id}/payment',
      'GET /bookings/{id}/price-adjustments',
      'POST /bookings/{id}/payment/authorize',
      'POST /bookings/{id}/payment/capture',
      'POST /bookings/{id}/price-adjustments',
      'POST /price-adjustments/{id}/approve',
      'POST /price-adjustments/{id}/reject',
    ]);
  });

  /** §3 "Rate limits" — the existing `payment` domain is reused; no new domain, no new threshold. */
  it('reuses spec 004’s existing payment rate-limit domain unchanged', () => {
    expect(RATE_LIMIT_DEFAULTS.payment).toEqual({ limit: 10, windowMs: 60_000 });
  });
});
