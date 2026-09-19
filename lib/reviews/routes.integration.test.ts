/**
 * Spec 029 §6 — the HTTP surface: auth, CSRF, idempotency, rate limiting and status codes.
 *
 * Exercised through the REAL route handlers, because the domain tests above prove the rules and
 * this file proves the routes actually apply them. A rule enforced in `lib/` but forgotten in a
 * `route.ts` is the failure mode this catches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_REVIEW, GET as GET_REVIEW_STATE } from '@/app/api/v1/bookings/[id]/reviews/route';
import { GET as LIST_PROVIDER_REVIEWS } from '@/app/api/v1/providers/[id]/reviews/route';
import { POST as CREATE_RESPONSE } from '@/app/api/v1/reviews/[id]/response/route';
import { POST as CREATE_REPORT } from '@/app/api/v1/reviews/[id]/reports/route';
import { GET as MODERATION_QUEUE } from '@/app/api/v1/admin/reviews/moderation-queue/route';
import { POST as RESOLVE_REVIEW } from '@/app/api/v1/admin/reviews/[id]/resolve/route';
import {
  BASE,
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  seedStranger,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';
import { sessionGet, sessionMutate } from '@/lib/bookings/bookings-test-support';

const reachable = await isDatabaseReachable();

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe.skipIf(!reachable)('spec 029 routes', () => {
  useTemporaryStorageDir();

  beforeAll(() => {
    useMessagingIntegration();
  });

  beforeEach(() => {
    useReviewsIntegration();
    resetRateLimitState();
  });

  afterAll(() => {
    resetReviewsIntegrationForTests();
  });

  async function completed(): Promise<{ scenario: BookingScenario; bookingId: string }> {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    return seeded;
  }

  function createReviewRequest(session: any, bookingId: string, body: unknown, key: string | null = freshKey()) {
    const base = sessionMutate(`${BASE}/bookings/${bookingId}/reviews`, session, 'POST', body);
    const headers = new Headers(base.headers);
    if (key !== null) headers.set('Idempotency-Key', key);
    return new Request(base, { headers });
  }

  describe('POST /bookings/{id}/reviews', () => {
    it('creates a review with 201 and replays with 200', async () => {
      const { scenario, bookingId } = await completed();
      const key = freshKey();

      const first = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 5 }, key));
      expect(first.status).toBe(201);
      const created = (await json(first)).data;
      expect(created).toMatchObject({ bookingId, rating: 5, status: 'published' });

      resetRateLimitState();
      const replay = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 5 }, key));
      expect(replay.status).toBe(200);
      expect((await json(replay)).data.id).toBe(created.id);
    });

    it('requires a session', async () => {
      const { bookingId } = await completed();
      const response = await CREATE_REVIEW(
        new Request(`${BASE}/bookings/${bookingId}/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rating: 5 }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('requires a CSRF token', async () => {
      const { scenario, bookingId } = await completed();
      const base = createReviewRequest(scenario.customer, bookingId, { rating: 5 });
      const headers = new Headers(base.headers);
      headers.delete('x-csrf-token');

      const response = await CREATE_REVIEW(new Request(base, { headers }));
      expect(response.status).toBe(403);
    });

    it('requires an Idempotency-Key', async () => {
      const { scenario, bookingId } = await completed();
      const response = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 5 }, null));
      expect(response.status).toBe(400);
    });

    it('requires customer active mode', async () => {
      const { scenario, bookingId } = await completed();
      // The provider is a participant, but reviewing is a customer act.
      const response = await CREATE_REVIEW(createReviewRequest(scenario.provider, bookingId, { rating: 5 }));
      expect(response.status).toBe(403);
    });

    it('returns 400 with a field error for an invalid rating', async () => {
      const { scenario, bookingId } = await completed();
      const response = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 9 }));
      expect(response.status).toBe(400);
      const body = await json(response);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.errors.map((e: any) => e.field)).toContain('rating');
    });

    it('returns 422 before completion', async () => {
      const seeded = await seedConfirmedBooking();
      const response = await CREATE_REVIEW(createReviewRequest(seeded.scenario.customer, seeded.bookingId, { rating: 5 }));
      expect(response.status).toBe(422);
      expect((await json(response)).code).toBe('BOOKING_NOT_ELIGIBLE_FOR_REVIEW');
    });
  });

  describe('GET /bookings/{id}/reviews', () => {
    it('returns the server-authoritative eligibility for the customer', async () => {
      const { scenario, bookingId } = await completed();
      const response = await GET_REVIEW_STATE(sessionGet(`${BASE}/bookings/${bookingId}/reviews`, scenario.customer));

      expect(response.status).toBe(200);
      const body = (await json(response)).data;
      expect(body).toMatchObject({ bookingId, eligible: true, reason: null, review: null });
      expect(body.windowClosesAt).toBeTruthy();
    });

    it('lets the provider read it too, with the honest reason', async () => {
      const { scenario, bookingId } = await completed();
      const response = await GET_REVIEW_STATE(sessionGet(`${BASE}/bookings/${bookingId}/reviews`, scenario.provider));
      expect(response.status).toBe(200);
      expect((await json(response)).data).toMatchObject({ eligible: false, reason: 'not_customer' });
    });

    it('gives a non-participant 404', async () => {
      const { bookingId } = await completed();
      const stranger = await seedStranger();
      const response = await GET_REVIEW_STATE(sessionGet(`${BASE}/bookings/${bookingId}/reviews`, stranger.customer));
      expect(response.status).toBe(404);
    });
  });

  describe('GET /providers/{id}/reviews', () => {
    it('is readable by a guest, with no session at all', async () => {
      const { scenario, bookingId } = await completed();
      await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 4 }));
      resetRateLimitState();

      const response = await LIST_PROVIDER_REVIEWS(
        new Request(`${BASE}/providers/${scenario.provider.providerProfileId}/reviews`),
      );
      expect(response.status).toBe(200);

      const body = await json(response);
      expect(body.data).toHaveLength(1);
      expect(body.page).toMatchObject({ limit: 20, offset: 0, total: 1, nextOffset: null });
      // No reviewer identity and no status reaches a public reader.
      expect(body.data[0]).not.toHaveProperty('status');
      expect(body.data[0]).not.toHaveProperty('authorUserId');
      expect(body.data[0]).not.toHaveProperty('bookingId');
    });

    it('returns an empty page for an unknown provider rather than an error', async () => {
      const response = await LIST_PROVIDER_REVIEWS(
        new Request(`${BASE}/providers/00000000-0000-4000-8000-000000000000/reviews`),
      );
      expect(response.status).toBe(200);
      expect((await json(response)).data).toEqual([]);
    });
  });

  describe('POST /reviews/{id}/response', () => {
    async function reviewed() {
      const { scenario, bookingId } = await completed();
      const created = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 2 }));
      resetRateLimitState();
      return { scenario, reviewId: (await json(created)).data.id as string };
    }

    function responseRequest(session: any, reviewId: string, body: unknown, key: string | null = freshKey()) {
      const base = sessionMutate(`${BASE}/reviews/${reviewId}/response`, session, 'POST', body);
      const headers = new Headers(base.headers);
      if (key !== null) headers.set('Idempotency-Key', key);
      return new Request(base, { headers });
    }

    it('posts one reply with 201', async () => {
      const { scenario, reviewId } = await reviewed();
      const response = await CREATE_RESPONSE(
        responseRequest(scenario.provider, reviewId, { text: 'Sorry about the delay — noted and fixed.' }),
      );
      expect(response.status).toBe(201);
    });

    it('requires provider active mode', async () => {
      const { scenario, reviewId } = await reviewed();
      const response = await CREATE_RESPONSE(
        responseRequest(scenario.customer, reviewId, { text: 'Replying to my own review somehow.' }),
      );
      expect(response.status).toBe(403);
    });

    it('requires a CSRF token', async () => {
      const { scenario, reviewId } = await reviewed();
      const base = responseRequest(scenario.provider, reviewId, { text: 'A perfectly fine reply here.' });
      const headers = new Headers(base.headers);
      headers.delete('x-csrf-token');
      expect((await CREATE_RESPONSE(new Request(base, { headers }))).status).toBe(403);
    });
  });

  describe('POST /reviews/{id}/reports', () => {
    async function reviewed() {
      const { scenario, bookingId } = await completed();
      const created = await CREATE_REVIEW(createReviewRequest(scenario.customer, bookingId, { rating: 1 }));
      resetRateLimitState();
      return { scenario, reviewId: (await json(created)).data.id as string };
    }

    function reportRequest(session: any, reviewId: string, body: unknown) {
      const base = sessionMutate(`${BASE}/reviews/${reviewId}/reports`, session, 'POST', body);
      const headers = new Headers(base.headers);
      headers.set('Idempotency-Key', freshKey());
      return new Request(base, { headers });
    }

    it('files a report with 201 and replays a duplicate with 200', async () => {
      const { reviewId } = await reviewed();
      const reporter = await seedStranger();

      const first = await CREATE_REPORT(reportRequest(reporter.customer, reviewId, { reason: 'spam' }));
      expect(first.status).toBe(201);

      resetRateLimitState();
      const second = await CREATE_REPORT(reportRequest(reporter.customer, reviewId, { reason: 'offensive' }));
      expect(second.status).toBe(200);
      expect((await json(second)).data.id).toBe((await json(first)).data.id);
    });

    it('rejects the author reporting their own review', async () => {
      const { scenario, reviewId } = await reviewed();
      const response = await CREATE_REPORT(reportRequest(scenario.customer, reviewId, { reason: 'spam' }));
      expect(response.status).toBe(422);
      expect((await json(response)).code).toBe('CANNOT_REPORT_OWN_REVIEW');
    });

    it('requires a session — a guest cannot report', async () => {
      const { reviewId } = await reviewed();
      const response = await CREATE_REPORT(
        new Request(`${BASE}/reviews/${reviewId}/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': freshKey() },
          body: JSON.stringify({ reason: 'spam' }),
        }),
      );
      expect(response.status).toBe(401);
    });
  });

  describe('admin routes', () => {
    async function flagged() {
      const { scenario, bookingId } = await completed();
      const created = await CREATE_REVIEW(
        createReviewRequest(scenario.customer, bookingId, { rating: 1, text: 'Email me at bob@example.com' }),
      );
      resetRateLimitState();
      return (await json(created)).data.id as string;
    }

    it('lets Trust & Safety read the queue and resolve', async () => {
      const reviewId = await flagged();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');

      const queue = await MODERATION_QUEUE(sessionGet(`${BASE}/admin/reviews/moderation-queue`, admin));
      expect(queue.status).toBe(200);
      expect((await json(queue)).data.map((r: any) => r.id)).toContain(reviewId);

      resetRateLimitState();
      const resolved = await RESOLVE_REVIEW(
        sessionMutate(`${BASE}/admin/reviews/${reviewId}/resolve`, admin, 'POST', {
          decision: 'remove',
          reason: 'Contains contact details on a public surface.',
          expectedStatus: 'flagged',
        }),
      );
      expect(resolved.status).toBe(200);
      expect((await json(resolved)).data.status).toBe('removed');
    });

    it.each(['finance_admin', 'content_admin', 'support_admin'] as const)('gives %s 403 on both', async (role) => {
      const reviewId = await flagged();
      const admin = await registerAdmin();
      await grantRole(admin, role);

      expect((await MODERATION_QUEUE(sessionGet(`${BASE}/admin/reviews/moderation-queue`, admin))).status).toBe(403);

      resetRateLimitState();
      const resolved = await RESOLVE_REVIEW(
        sessionMutate(`${BASE}/admin/reviews/${reviewId}/resolve`, admin, 'POST', {
          decision: 'remove',
          reason: 'Attempting a removal without the permission.',
          expectedStatus: 'flagged',
        }),
      );
      expect(resolved.status).toBe(403);
    });

    it('gives an ordinary customer 403', async () => {
      const { scenario } = await completed();
      expect((await MODERATION_QUEUE(sessionGet(`${BASE}/admin/reviews/moderation-queue`, scenario.customer))).status).toBe(
        403,
      );
    });

    it('requires a reason on resolve', async () => {
      const reviewId = await flagged();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');

      const response = await RESOLVE_REVIEW(
        sessionMutate(`${BASE}/admin/reviews/${reviewId}/resolve`, admin, 'POST', {
          decision: 'remove',
          reason: 'too short',
          expectedStatus: 'flagged',
        }),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).errors.map((e: any) => e.field)).toContain('reason');
    });
  });

  it('rate-limits the reviews domain', async () => {
    const { scenario, bookingId } = await completed();
    resetRateLimitState();

    let limited = false;
    for (let i = 0; i < 40; i += 1) {
      const response = await GET_REVIEW_STATE(sessionGet(`${BASE}/bookings/${bookingId}/reviews`, scenario.customer));
      if (response.status === 429) {
        limited = true;
        expect((await json(response)).code).toBe('RATE_LIMITED');
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
