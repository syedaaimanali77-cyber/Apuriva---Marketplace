/**
 * Spec 029 §6 — the rating aggregate and the spec 017 `ProviderRatingSource` port.
 *
 * The property under test is a BOUNDARY one: spec 029 supplies a number, spec 017 decides what to
 * do with it, and the port's default is spec 017's pre-029 behaviour — so rolling this spec back
 * restores spec 017 exactly, with no code change there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getProviderRatingSource, resetProviderRatingSource } from '@/lib/matching/rating-source';
import { registerReviewsIntegration } from './index';
import { createReview } from './create';
import { resolveReviewModeration } from './moderation';
import { getProviderRatingAggregate, getProviderRatingAggregates } from './aggregate';
import {
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  shiftScheduledAtToNow,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('spec 029 rating aggregate and the spec 017 port', () => {
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

  /** One provider, reviewed by N different customers — the real shape of an aggregate. */
  async function providerWithRatings(ratings: Array<1 | 2 | 3 | 4 | 5>, text: string | null = null) {
    const first = await seedConfirmedBooking();
    const providerProfileId = first.scenario.provider.providerProfileId;

    const reviewIds: string[] = [];
    const scenarios: Array<{ scenario: BookingScenario; bookingId: string }> = [first];

    const { seedRivalForSameProvider, futureLocalSlot } = await import('@/lib/bookings/bookings-test-support');
    const { createBooking } = await import('@/lib/bookings/create');
    const { authorizePayment } = await import('@/lib/payments/authorize');
    const { createBookingBody } = await import('@/lib/payments/payments-test-support');

    for (let i = 1; i < ratings.length; i += 1) {
      const rival = await seedRivalForSameProvider(first.scenario);
      // Each booking gets its OWN slot: they share a provider, and spec 016 refuses a second
      // booking that overlaps an existing one (`SLOT_NO_LONGER_AVAILABLE`). Staggering by day is
      // what makes several reviews of one provider a legitimate scenario rather than a conflict.
      const { booking } = await createBooking(
        rival.customer.userId,
        freshKey(),
        createBookingBody(rival.offerId, futureLocalSlot(i, 9 + i)),
      );
      await authorizePayment(rival.customer.userId, booking.id, freshKey());
      scenarios.push({ scenario: rival, bookingId: booking.id });
    }

    for (const [index, entry] of scenarios.entries()) {
      // Spec 020 safeguard S4 refuses to advance a booking more than `EARLY_START_GRACE_MINUTES`
      // before its scheduled time, and the staggered slots above are days out.
      await shiftScheduledAtToNow(entry.bookingId);
      await completeBookingForReview(entry.scenario, entry.bookingId);
      const { review } = await createReview(
        entry.scenario.customer.userId,
        entry.bookingId,
        { rating: ratings[index]!, text, mediaFileAssetIds: [] },
        { key: freshKey(), fingerprint: 'f' },
      );
      reviewIds.push(review.id);
    }

    return { providerProfileId, reviewIds };
  }

  it('is absent, not zero, for a provider with no reviews', async () => {
    // "Not yet rated" and "rated zero" are different facts: spec 017 excludes a `null` factor from
    // both the numerator and the denominator, so returning 0 here would silently punish every new
    // provider.
    const seeded = await seedConfirmedBooking();
    const map = await getProviderRatingAggregates([seeded.scenario.provider.providerProfileId]);
    expect(map.has(seeded.scenario.provider.providerProfileId)).toBe(false);

    const source = getProviderRatingSource();
    const ported = await source([seeded.scenario.provider.providerProfileId]);
    expect(ported.get(seeded.scenario.provider.providerProfileId)).toBeUndefined();
  });

  it('averages visible reviews to one decimal place', async () => {
    const { providerProfileId } = await providerWithRatings([5, 4]);
    expect(await getProviderRatingAggregate(providerProfileId)).toEqual({ average: 4.5, count: 2 });
  }, 120_000);

  it('rounds to what the design system can actually display', async () => {
    // `ui/components/marketplace/Rating` renders `value.toFixed(1)`; storing more precision would
    // be a number nobody could verify against the stars they see.
    const { providerProfileId } = await providerWithRatings([5, 4, 4]);
    expect(await getProviderRatingAggregate(providerProfileId)).toEqual({ average: 4.3, count: 3 });
  }, 120_000);

  it('COUNTS a flagged review — excluding it would be an invisible heuristic penalty', async () => {
    const { providerProfileId } = await providerWithRatings([1], 'Email me at bob@example.com');
    expect(await getProviderRatingAggregate(providerProfileId)).toEqual({ average: 1, count: 1 });
  });

  it('drops a removed review from the aggregate', async () => {
    const { providerProfileId, reviewIds } = await providerWithRatings([1], 'Email me at bob@example.com');
    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');

    await resolveReviewModeration({
      adminUserId: admin.userId,
      reviewId: reviewIds[0]!,
      decision: 'remove',
      reason: 'Removed after Trust & Safety review.',
      expectedStatus: 'flagged',
      correlationId: 'c',
    });

    expect(await getProviderRatingAggregate(providerProfileId)).toEqual({ average: 0, count: 0 });
  });

  describe('the spec 017 port', () => {
    it('defaults to null for every provider when unregistered — spec 017 pre-029 behaviour', async () => {
      resetProviderRatingSource();
      const { providerProfileId } = await providerWithRatings([5]);

      const ported = await getProviderRatingSource()([providerProfileId]);
      expect(ported.size).toBe(0);

      // Re-register so the remaining tests in this file see the wired state.
      registerReviewsIntegration();
    });

    it('normalizes 1..5 stars onto the 0..1 scale spec 017 scores with', async () => {
      // `scoreProvider` multiplies each factor by its weight and expects every factor on the same
      // scale, so the mapping lives here — in spec 029's own module — rather than in spec 017.
      const worst = await providerWithRatings([1]);
      const best = await providerWithRatings([5]);

      const source = getProviderRatingSource();
      expect((await source([worst.providerProfileId])).get(worst.providerProfileId)).toBe(0);
      expect((await source([best.providerProfileId])).get(best.providerProfileId)).toBe(1);
    });

    it('batches a whole matching pool in one call', async () => {
      const a = await providerWithRatings([4]);
      const b = await providerWithRatings([2]);
      const unrated = await seedConfirmedBooking();

      const ported = await getProviderRatingSource()([
        a.providerProfileId,
        b.providerProfileId,
        unrated.scenario.provider.providerProfileId,
      ]);

      expect(ported.get(a.providerProfileId)).toBeCloseTo(0.75, 5);
      expect(ported.get(b.providerProfileId)).toBeCloseTo(0.25, 5);
      expect(ported.has(unrated.scenario.provider.providerProfileId)).toBe(false);
    }, 120_000);

    it('ignores malformed ids rather than reaching the database with them', async () => {
      expect((await getProviderRatingAggregates(['not-a-uuid'])).size).toBe(0);
      expect((await getProviderRatingAggregates([])).size).toBe(0);
    });
  });
});
