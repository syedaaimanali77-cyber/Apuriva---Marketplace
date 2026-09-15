import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { RATE_LIMIT_DEFAULTS } from '@/lib/api/rate-limit';
import { grantRole, registerAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { GET as LIST_REFUNDS, POST as CREATE_REFUND } from '@/app/api/v1/bookings/[id]/refunds/route';
import { GET as ADMIN_LIST, POST as ADMIN_CREATE } from '@/app/api/v1/admin/refunds/route';
import { GET as SWEEP } from '@/app/api/v1/cron/refund-reconcile-sweep/route';
import { PAYMENT_PROVIDER_ENV_VAR } from '@/lib/payments/provider';
import {
  allowRefund,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  resetRefundIntegration,
  seedCapturedBooking,
  seedStranger,
  sessionGet,
  sessionMutate,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;
const BASE = 'http://localhost/api/v1';

afterAll(async () => {
  await getPool().end();
});

function keyed(request: Request, key = freshKey()): Request {
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', key);
  return new Request(request, { headers });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe.skipIf(!dbReachable)('refund routes (spec 022 §3 "Endpoints")', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** The happy path through the real handler, with the real guard sequence in front of it. */
  it('creates and reads back a policy refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const created = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));
    expect(created.status).toBe(201);
    expect((await body(created)).data).toMatchObject({ status: 'completed', totalAmountMinorUnits: 50_000 });

    const listed = await LIST_REFUNDS(sessionGet(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer));
    expect(listed.status).toBe(200);
    const refunds = (await body(listed)).data as Record<string, unknown>[];
    expect(refunds).toHaveLength(1);

    // §4 "Retention and privacy": nothing provider-facing or admin-internal is serialized.
    expect(refunds[0]).not.toHaveProperty('providerReference');
    expect(refunds[0]).not.toHaveProperty('refundReference');
    expect(refunds[0]).not.toHaveProperty('failureCode');
    expect(refunds[0]).not.toHaveProperty('adminActionId');
    expect(JSON.stringify(refunds[0])).not.toMatch(/sandbox_/);
  });

  /**
   * §3 — THE customer route carries no amount. Even a client that supplies one cannot influence
   * the refund: the amount comes from the eligibility decision, server-side.
   */
  it('ignores any client-supplied amount on the customer route', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const created = await CREATE_REFUND(
      keyed(
        sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST', {
          amountMinorUnits: 999_999,
          totalAmountMinorUnits: 999_999,
        }),
      ),
    );
    expect(created.status).toBe(201);
    expect((await body(created)).data).toMatchObject({ totalAmountMinorUnits: 50_000 });
  });

  it('requires a session', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    void scenario;

    const response = await CREATE_REFUND(keyed(new Request(`${BASE}/bookings/${bookingId}/refunds`, { method: 'POST' })));
    expect(response.status).toBe(401);
  });

  it('requires a CSRF token on the mutation', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const noCsrf = new Request(`${BASE}/bookings/${bookingId}/refunds`, {
      method: 'POST',
      headers: { cookie: `apuriva_session=${scenario.customer.sessionId}`, 'Idempotency-Key': freshKey() },
    });
    const response = await CREATE_REFUND(noCsrf);
    expect(response.status).toBe(403);
    expect((await body(response)).code).toBe('CSRF_TOKEN_INVALID');
  });

  /** Only the customer may request a policy refund; the provider is in the wrong mode. */
  it('requires customer mode', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const response = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.provider, 'POST')));
    expect(response.status).toBe(403);
  });

  it('requires an Idempotency-Key', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const response = await CREATE_REFUND(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST'));
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.errors).toMatchObject([{ field: 'Idempotency-Key' }]);
  });

  /** A stranger gets `404`, never `403`: booking ids must not be probeable. */
  it('hides a booking from a non-participant behind 404, never 403', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const stranger = await seedStranger();
    void scenario;

    const created = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, stranger.customer, 'POST')));
    expect(created.status).toBe(404);

    const listed = await LIST_REFUNDS(sessionGet(`${BASE}/bookings/${bookingId}/refunds`, stranger.customer));
    expect(listed.status).toBe(404);
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** The provider may see that a refund happened, and how much — but nothing provider-facing. */
  it('lets the provider read refunds on their own booking', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));

    const listed = await LIST_REFUNDS(sessionGet(`${BASE}/bookings/${bookingId}/refunds`, scenario.provider));
    expect(listed.status).toBe(200);
    const refunds = (await body(listed)).data as Record<string, unknown>[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).not.toHaveProperty('refundReference');
  });

  /** AC-1 at the transport layer — with no policy registered nothing is automatically refundable. */
  it('answers 422 REFUND_NOT_ELIGIBLE when no policy allows it', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const response = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));
    expect(response.status).toBe(422);
    expect((await body(response)).code).toBe('REFUND_NOT_ELIGIBLE');
  });

  /** An unusable adapter is `503`, never a 500 and never a silent success. */
  it('answers 503 PAYMENT_PROVIDER_UNAVAILABLE when no adapter resolves', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const original = process.env[PAYMENT_PROVIDER_ENV_VAR];
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'no-such-adapter';
    try {
      const response = await CREATE_REFUND(keyed(sessionMutate(`${BASE}/bookings/${bookingId}/refunds`, scenario.customer, 'POST')));
      expect(response.status).toBe(503);
      expect((await body(response)).code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    } finally {
      process.env[PAYMENT_PROVIDER_ENV_VAR] = original;
    }
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-3 at the transport layer — initiating answers 202 and refunds nothing. */
  it('the admin override route answers 202 pending approval and creates no refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await registerAdmin();
    await grantRole(admin, 'finance_admin');
    void scenario;

    const response = await ADMIN_CREATE(
      keyed(
        sessionMutate(`${BASE}/admin/refunds`, admin, 'POST', {
          bookingId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          reason: 'Goodwill',
        }),
      ),
    );

    expect(response.status).toBe(202);
    expect((await body(response)).data).toMatchObject({ status: 'pending_approval', bookingId });
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** An admin without the permission cannot initiate an override. */
  it('the admin override route is 403 without the refunds permission', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const admin = await registerAdmin();
    await grantRole(admin, 'support_admin');
    void scenario;

    const response = await ADMIN_CREATE(
      keyed(
        sessionMutate(`${BASE}/admin/refunds`, admin, 'POST', {
          bookingId,
          amountMinorUnits: 50_000,
          currencyCode: 'PKR',
          reason: 'Goodwill',
        }),
      ),
    );
    expect(response.status).toBe(403);
  });

  /** The admin listing is gated on `refunds/read` and is the one surface showing the approval id. */
  it('the admin listing requires the refunds/read permission', async () => {
    const outsider = await registerAdmin();
    await grantRole(outsider, 'support_admin');
    const finance = await registerAdmin();
    await grantRole(finance, 'finance_admin');

    expect((await ADMIN_LIST(sessionGet(`${BASE}/admin/refunds`, outsider))).status).toBe(403);
    expect((await ADMIN_LIST(sessionGet(`${BASE}/admin/refunds`, finance))).status).toBe(200);
  });

  it('rejects an invalid status filter on the admin listing', async () => {
    const finance = await registerAdmin();
    await grantRole(finance, 'finance_admin');

    const response = await ADMIN_LIST(sessionGet(`${BASE}/admin/refunds?status=nonsense`, finance));
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe('VALIDATION_ERROR');
  });

  /** The sweep is not a browser route: bearer-authenticated like every other cron. */
  it('refuses the sweep without the cron secret', async () => {
    const response = await SWEEP(new Request(`${BASE}/cron/refund-reconcile-sweep`) as NextRequest);
    expect(response.status).toBe(401);
  });

  it('runs the sweep with the cron secret', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const response = await SWEEP(
        new Request(`${BASE}/cron/refund-reconcile-sweep`, {
          headers: { authorization: 'Bearer test-cron-secret' },
        }) as NextRequest,
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
describe('refund route registration (spec 022 §3)', () => {
  const registered = OPENAPI_ROUTES.filter((route) => route.tags.includes('refunds'));

  it('registers every refund route in OPENAPI_ROUTES', () => {
    expect(registered.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /admin/refunds',
      'GET /bookings/{id}/refunds',
      'POST /admin/refunds',
      'POST /bookings/{id}/refunds',
    ]);
  });

  /** §3 — approval listing/decisions reuse spec 009's routes; this spec adds none of its own. */
  it('adds no refund-specific approval route', () => {
    expect(registered.some((route) => /approval/i.test(route.path))).toBe(false);
    expect(OPENAPI_ROUTES.some((route) => route.path === '/admin/approvals/pending')).toBe(true);
  });

  /** §3 "Rate limits" — the existing `payment` domain is reused; no new domain, no new threshold. */
  it('reuses spec 004’s existing payment rate-limit domain unchanged', () => {
    expect(RATE_LIMIT_DEFAULTS.payment).toEqual({ limit: 10, windowMs: 60_000 });
  });
});
