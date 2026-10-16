/**
 * Spec 045 §6 "Route-level" — the customer demo journey, end to end through the REAL route handlers against the
 * isolated `*_test` database (the repository's Vitest e2e convention; there is no Playwright here):
 *
 *   demo login → search → request → offers → booking → sandbox payment → review
 *
 * Nothing demo-specific happens after the login: every later step is the platform's normal code acting on the
 * demo set's rows, which is the point of D-4 ("no demo branch anywhere"). The provider's side of the offer is
 * taken by whichever provider spec 017's matching distributed the request to, signed in through spec 005's
 * `completeLogin` (demo providers have no password; a visitor only ever plays the persona). The review is left
 * on the persona's seeded, completed booking — the one AC-2 deliberately leaves unreviewed.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { completeLogin } from '@/lib/auth/login-flow';
import { deriveCsrfToken } from '@/lib/auth/csrf';
import { addDays, utcToZoned, zonedDateTimeToUtc } from '@/lib/availability/timezone';
import { runMatching } from '@/lib/matching/run';
import { resetPaymentIntegration, usePaymentIntegration } from '@/lib/payments/payments-test-support';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { enterDemoEnvironment, isDatabaseReachable } from '@/lib/demo/demo-test-support';
import { loginAs, type DemoVisitor } from '@/app/api/v1/demo/demo-route-test-support';
import { GET as SEARCH } from '@/app/api/v1/search/route';
import { POST as CREATE_REQUEST } from '@/app/api/v1/requests/route';
import { PATCH as SWITCH_MODE } from '@/app/api/v1/users/me/active-mode/route';
import { POST as CREATE_OFFER } from '@/app/api/v1/offers/route';
import { POST as ACCEPT_OFFER } from '@/app/api/v1/offers/[id]/accept/route';
import { POST as CREATE_BOOKING } from '@/app/api/v1/bookings/route';
import { POST as AUTHORIZE } from '@/app/api/v1/bookings/[id]/payment/authorize/route';
import { POST as CREATE_REVIEW } from '@/app/api/v1/bookings/[id]/reviews/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

function as(visitor: DemoVisitor, url: string, method: string, body?: unknown): Request {
  const req = authenticatedRequest(url, visitor.sessionId, visitor.csrfToken, { method, body });
  if (method !== 'GET') req.headers.set('Idempotency-Key', randomUUID());
  return req;
}

async function data<T>(res: Response, status: number): Promise<T> {
  const json = (await res.json()) as { data: T };
  expect(res.status, JSON.stringify(json)).toBe(status);
  return json.data;
}

describe.skipIf(!dbReachable)('e2e: spec 045 customer demo journey', { timeout: 120_000 }, () => {
  let restore: () => void;
  beforeAll(() => {
    restore = enterDemoEnvironment();
    usePaymentIntegration();
  });
  afterAll(() => {
    resetPaymentIntegration();
    restore?.();
  });

  it('one-click demo login, then search, request, offer, booking, sandbox payment and a review', async () => {
    resetRateLimitState();
    const customer = await loginAs('customer', '203.0.113.120');

    // Search (spec 013) — the catalog the demo set uses is the real 0006 catalog.
    const search = await SEARCH(as(customer, `${BASE}/search?q=cleaning`, 'GET'));
    expect(search.status).toBe(200);

    // Request (spec 015), from the persona's own seeded address.
    const [context] = await queryRows<{ address_id: string; service_id: string }>(
      getDb(),
      sql`SELECT a.id AS address_id, (SELECT id FROM services WHERE slug = 'home-cleaning') AS service_id
            FROM addresses a WHERE a.user_id = ${customer.userId}`,
    );
    const request = await data<{ id: string; status: string }>(
      await CREATE_REQUEST(
        as(customer, `${BASE}/requests`, 'POST', {
          serviceId: context!.service_id,
          description: 'Clean a two-bedroom flat before guests arrive.',
          fieldValues: { details: 'Two bedrooms, one bathroom, kitchen and lounge.' },
          addressId: context!.address_id,
          urgency: 'normal',
        }),
      ),
      201,
    );
    expect(request.status).toBe('submitted');

    // Distribution (spec 017), as its cron runs it; then one distributed provider sends an offer (spec 018).
    await runMatching(request.id);
    const [match] = await queryRows<{ user_id: string }>(
      getDb(),
      sql`SELECT pp.user_id FROM request_provider_matches m JOIN provider_profiles pp ON pp.id = m.provider_profile_id
           WHERE m.request_id = ${request.id} AND m.eligible AND m.notified_at IS NOT NULL
           ORDER BY (SELECT u.demo_set_id FROM users u WHERE u.id = pp.user_id) IS NOT DISTINCT FROM
                    (SELECT u.demo_set_id FROM users u WHERE u.id = ${customer.userId}) DESC, m.rank
           LIMIT 1`,
    );
    expect(match).toBeDefined();
    const { session } = await completeLogin(match!.user_id, 'demo');
    const provider: DemoVisitor = { userId: match!.user_id, sessionId: session.id, csrfToken: deriveCsrfToken(session.id) };
    await data(await SWITCH_MODE(as(provider, `${BASE}/users/me/active-mode`, 'PATCH', { mode: 'provider' })), 200);
    const offer = await data<{ id: string }>(
      await CREATE_OFFER(
        as(provider, `${BASE}/offers`, 'POST', {
          requestId: request.id,
          priceAmountMinorUnits: 450_000,
          currencyCode: 'PKR',
          includedItems: ['Supplies'],
          providerMessage: 'Available tomorrow morning.',
          estimatedDurationMinutes: 120,
        }),
      ),
      201,
    );

    // Accept (spec 018) and book (spec 020) a slot tomorrow morning, in the provider's zone.
    await data(await ACCEPT_OFFER(as(customer, `${BASE}/offers/${offer.id}/accept`, 'POST')), 200);
    const tomorrow = addDays(utcToZoned(new Date(), 'Asia/Karachi').date, 1);
    // If that slot is taken, take the first time the API itself suggests — exactly what the booking screen offers.
    let created = await CREATE_BOOKING(as(customer, `${BASE}/bookings`, 'POST', { offerId: offer.id, scheduledAt: zonedDateTimeToUtc(tomorrow, 9 * 60, 'Asia/Karachi').toISOString() }));
    if (created.status === 422) {
      const refusal = (await created.json()) as { code: string; details: { alternatives: { startAt: string }[] } };
      expect(refusal.code).toBe('SLOT_NO_LONGER_AVAILABLE');
      created = await CREATE_BOOKING(as(customer, `${BASE}/bookings`, 'POST', { offerId: offer.id, scheduledAt: refusal.details.alternatives[0]!.startAt }));
    }
    const booking = await data<{ id: string; status: string }>(created, 201);
    expect(booking.status).toBe('pending');

    // Pay through spec 021's sandbox adapter — no demo branch: an ordinary amount is captured and confirms.
    const payment = await data<{ status: string }>(
      await AUTHORIZE(as(customer, `${BASE}/bookings/${booking.id}/payment/authorize`, 'POST')),
      200,
    );
    expect(payment.status).toBe('captured');
    const [stored] = await queryRows<{ provider_name: string; provider_reference: string; booking_status: string }>(
      getDb(),
      sql`SELECT p.provider_name, p.provider_reference, b.status AS booking_status
            FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.booking_id = ${booking.id}`,
    );
    expect(stored).toMatchObject({ provider_name: 'sandbox', booking_status: 'confirmed' });
    expect(stored!.provider_reference.startsWith('sandbox_')).toBe(true);

    // Review (spec 029) the persona's seeded completed booking.
    const [completed] = await queryRows<{ id: string }>(
      getDb(),
      sql`SELECT b.id FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
           WHERE cp.user_id = ${customer.userId} AND b.status = 'completed' LIMIT 1`,
    );
    const review = await data<{ rating: number; status: string }>(
      await CREATE_REVIEW(
        as(customer, `${BASE}/bookings/${completed!.id}/reviews`, 'POST', { rating: 5, text: 'Quick, tidy and friendly work.' }),
      ),
      201,
    );
    expect(review).toMatchObject({ rating: 5, status: 'published' });
  });
});
