import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec 040 AC-1 / AC-5 — each of the six X-list emitters records exactly one event, AFTER its action,
 * with the §3.4 properties; an idempotent replay records nothing; and an analytics insert that fails
 * never changes the tracked action's outcome.
 *
 * `@/lib/db` is wrapped (never replaced) so a test can make ONLY the `analytics_events` insert fail —
 * every other query goes to the real isolated `*_test` database untouched.
 */
const control = vi.hoisted(() => ({ failAnalyticsInsert: false }));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  const { analyticsEvents } = await import('@/lib/db/schema');
  return {
    ...actual,
    getDb: () => {
      const db = actual.getDb();
      if (!control.failAnalyticsInsert) return db;
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'insert') {
            return (table: unknown) =>
              table === analyticsEvents
                ? { values: async () => Promise.reject(new Error('analytics insert failed (test)')) }
                : target.insert(table as never);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { getDb } = await import('@/lib/db');
const { queryRows } = await import('@/lib/offers/db');
const { resetRateLimitState } = await import('@/lib/api/rate-limit');
const { drainAnalyticsForTests, resetAnalyticsForTests } = await import('./ingest');
const { GET: SEARCH } = await import('@/app/api/v1/search/route');
const { createRequest } = await import('@/lib/requests/create');
const { acceptOffer } = await import('@/lib/offers/decide');
const { completeBooking } = await import('@/lib/bookings/complete');
const { createReview } = await import('@/lib/reviews/create');
const { createConversation } = await import('@/lib/ai-assistant/conversations');
const { seedBookingScenario, driveToInProgress, isDatabaseReachable } = await import('@/lib/bookings/bookings-test-support');
const { registerCustomerWithAddress, seedPublishedService, validRequestBody } = await import(
  '@/app/api/v1/requests/requests-test-support'
);
const reviewSupport = await import('@/lib/reviews/reviews-test-support');

const dbReachable = await isDatabaseReachable();

interface EventRow {
  event_type: string;
  actor_user_id: string | null;
  properties: Record<string, unknown>;
  occurred_at: string | Date;
}

/** This test's events, found by a property only it can have produced. */
async function eventsWhere(type: string, key: string, value: string): Promise<EventRow[]> {
  await drainAnalyticsForTests();
  return queryRows<EventRow>(
    getDb(),
    sql`SELECT event_type, actor_user_id, properties, occurred_at FROM analytics_events
         WHERE event_type = ${type} AND properties ->> ${key} = ${value}`,
  );
}

describe.skipIf(!dbReachable)('spec 040 emitters X-1…X-6 (AC-1, AC-5)', { timeout: 240_000 }, () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    control.failAnalyticsInsert = false;
    resetAnalyticsForTests();
    resetRateLimitState();
    warn = vi.spyOn(console, 'warn');
  });

  afterEach(async () => {
    await drainAnalyticsForTests();
    control.failAnalyticsInsert = false;
    warn.mockRestore();
  });

  afterAll(async () => {
    await drainAnalyticsForTests();
  });

  it('X-1 search: one guest event for the first page with no search text, none for later pages', async () => {
    const serviceId = randomUUID();
    const first = await SEARCH(new Request(`http://localhost/api/v1/search?q=leaking+tap&serviceId=${serviceId}`));
    expect(first.status).toBe(200);
    const later = await SEARCH(new Request(`http://localhost/api/v1/search?q=leaking+tap&serviceId=${serviceId}&offset=20`));
    expect(later.status).toBe(200);

    const rows = await eventsWhere('search_performed', 'serviceId', serviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBeNull();
    expect(rows[0]!.properties).toEqual({ serviceId, hasQuery: true, hasLocation: false, resultCount: 0 });
    expect(JSON.stringify(rows[0])).not.toContain('leaking');
  });

  it('X-2 request submitted: one event after the commit; a replay records nothing', async () => {
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    const key = randomUUID();
    const before = new Date();
    const created = await createRequest(customer.userId, key, validRequestBody(service, customer.addressId));
    expect(created.replayed).toBe(false);
    const replay = await createRequest(customer.userId, key, validRequestBody(service, customer.addressId));
    expect(replay.replayed).toBe(true);

    const rows = await eventsWhere('request_submitted', 'requestId', created.request.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: customer.userId, properties: { requestId: created.request.id, serviceId: service.id } });
    expect(new Date(rows[0]!.occurred_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('X-3 offer accepted: one event only for the call that accepted; the idempotent replay records nothing', async () => {
    const scenario = await seedBookingScenario({ accept: false });
    const key = randomUUID();
    await acceptOffer(scenario.customer.userId, scenario.offerId, key);
    await acceptOffer(scenario.customer.userId, scenario.offerId, key);

    const rows = await eventsWhere('offer_accepted', 'offerId', scenario.offerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: scenario.customer.userId,
      properties: { offerId: scenario.offerId, requestId: scenario.requestId },
    });
  });

  it('X-4 booking completed: one event for the call that applied the transition, none for a retry', async () => {
    reviewSupport.useMessagingIntegration();
    try {
      const { scenario, bookingId } = await reviewSupport.seedConfirmedBooking();
      await driveToInProgress(scenario as never, bookingId);
      await completeBooking(scenario.provider.userId, bookingId, 'provider');
      // The idempotent retry succeeds without re-applying the transition.
      await completeBooking(scenario.provider.userId, bookingId, 'provider');

      const rows = await eventsWhere('booking_completed', 'bookingId', bookingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_user_id: scenario.provider.userId, properties: { bookingId, actingAs: 'provider' } });
    } finally {
      reviewSupport.resetMessagingIntegration();
    }
  });

  it('X-5 review submitted: one event with the rating and no text; a replay records nothing', async () => {
    reviewSupport.useMessagingIntegration();
    reviewSupport.useReviewsIntegration();
    try {
      const { scenario, bookingId } = await reviewSupport.seedConfirmedBooking();
      await reviewSupport.completeBookingForReview(scenario, bookingId);
      await drainAnalyticsForTests();
      const idempotency = { key: randomUUID(), fingerprint: 'spec040' };
      const input = { rating: 4 as const, text: 'Private words that must never reach analytics.', mediaFileAssetIds: [] };
      const created = await createReview(scenario.customer.userId, bookingId, input, idempotency);
      const replay = await createReview(scenario.customer.userId, bookingId, input, idempotency);
      expect(replay.replayed).toBe(true);

      const rows = await eventsWhere('review_submitted', 'reviewId', created.review.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: scenario.customer.userId,
        properties: { reviewId: created.review.id, bookingId, rating: 4 },
      });
      expect(JSON.stringify(rows[0])).not.toContain('Private words');
    } finally {
      reviewSupport.resetReviewsIntegrationForTests();
      reviewSupport.resetMessagingIntegration();
    }
  });

  it('X-6 AI conversation started: one event; a replay records nothing', async () => {
    const customer = await registerCustomerWithAddress();
    const key = randomUUID();
    const created = await createConversation(customer.userId, key, {});
    const replay = await createConversation(customer.userId, key, {});
    expect(replay.replayed).toBe(true);

    const rows = await eventsWhere('ai_conversation_started', 'conversationId', created.conversation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(customer.userId);
  });

  it('a failed action records nothing', async () => {
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();
    await expect(
      createRequest(customer.userId, randomUUID(), validRequestBody(service, customer.addressId, { description: '' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await drainAnalyticsForTests();
    const rows = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM analytics_events WHERE actor_user_id = ${customer.userId}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('AC-5: when the analytics insert fails, the tracked actions still succeed with unchanged results', async () => {
    control.failAnalyticsInsert = true;
    const customer = await registerCustomerWithAddress();
    const service = await seedPublishedService();

    const created = await createRequest(customer.userId, randomUUID(), validRequestBody(service, customer.addressId));
    expect(created.replayed).toBe(false);
    expect(created.request).toMatchObject({ serviceId: service.id });
    const conversation = await createConversation(customer.userId, randomUUID(), {});
    expect(conversation.replayed).toBe(false);
    const search = await SEARCH(new Request(`http://localhost/api/v1/search?serviceId=${service.id}`));
    expect(search.status).toBe(200);

    await drainAnalyticsForTests();
    control.failAnalyticsInsert = false;
    // Dropped and logged, never retried.
    expect(await eventsWhere('request_submitted', 'requestId', created.request.id)).toHaveLength(0);
    expect(await eventsWhere('ai_conversation_started', 'conversationId', conversation.conversation.id)).toHaveLength(0);
    const failures = warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((line: string) => line.includes('analytics.flush_failed'));
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });
});
