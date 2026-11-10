/**
 * Spec 029 §6 — AC-7 under CONCURRENCY.
 *
 * The scenario the unique index exists for: two submissions for the same booking, issued at the
 * same moment, both of which pass the eligibility read because neither has committed yet. A
 * read-then-write could not promise a single review here; `reviews_booking_id_uq` can.
 *
 * Shaped after `lib/bookings/create-race.integration.test.ts`, which proves the same property for
 * one booking per offer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { ApiRouteError } from '@/lib/api/errors';
import { createReview } from './create';
import {
  completeBookingForReview,
  countReviews,
  freshKey,
  isDatabaseReachable,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('spec 029 concurrent review submission (AC-7)', () => {
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

  it('two simultaneous submissions produce exactly one review, and the loser gets 409', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await completeBookingForReview(scenario, bookingId);

    // Distinct idempotency keys on purpose: with the SAME key this would be an idempotent replay,
    // which is a different (and also tested) property. Different keys make these two genuinely
    // separate requests racing for the one review slot.
    const attempt = (rating: 1 | 5) =>
      createReview(
        scenario.customer.userId,
        bookingId,
        { rating, text: null, mediaFileAssetIds: [] },
        { key: freshKey(), fingerprint: `f-${rating}` },
      );

    const results = await Promise.allSettled([attempt(5), attempt(1)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as ApiRouteError;
    expect(error).toBeInstanceOf(ApiRouteError);
    expect(error.code).toBe('REVIEW_ALREADY_EXISTS');
    expect(error.status).toBe(409);

    expect(await countReviews(bookingId)).toBe(1);
  });

  it('holds for five simultaneous submissions', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await completeBookingForReview(scenario, bookingId);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        createReview(
          scenario.customer.userId,
          bookingId,
          { rating: 4, text: null, mediaFileAssetIds: [] },
          { key: freshKey(), fingerprint: `f-${i}` },
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect(((result as PromiseRejectedResult).reason as ApiRouteError).code).toBe('REVIEW_ALREADY_EXISTS');
    }
    expect(await countReviews(bookingId)).toBe(1);
  });

  it('a concurrent retry of the SAME request replays rather than conflicting', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await completeBookingForReview(scenario, bookingId);

    const key = freshKey();
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        createReview(
          scenario.customer.userId,
          bookingId,
          { rating: 4, text: null, mediaFileAssetIds: [] },
          { key, fingerprint: 'same' },
        ),
      ),
    );

    // At least one succeeds; every settled result that succeeded names the same review, and any
    // rejection is the duplicate-review answer rather than a 500.
    const ids = new Set(
      results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<any>).value.review.id),
    );
    expect(ids.size).toBe(1);
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect(((result as PromiseRejectedResult).reason as ApiRouteError).code).toBe('REVIEW_ALREADY_EXISTS');
    }
    expect(await countReviews(bookingId)).toBe(1);
  });
});
