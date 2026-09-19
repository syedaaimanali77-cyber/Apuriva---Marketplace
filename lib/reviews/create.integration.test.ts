/**
 * Spec 029 §6 — AC-2 (ownership, content, media) and AC-7 (one review per booking).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { isUniqueViolation } from '@/lib/offers/db';
import { createReview } from './create';
import { listProviderReviews } from './read';
import {
  completeBookingForReview,
  countReviews,
  freshKey,
  isDatabaseReachable,
  resetReviewsIntegrationForTests,
  reviewRowById,
  seedConfirmedBooking,
  uploadReviewMedia,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();
const PAGE = { limit: 20, offset: 0 };

describe.skipIf(!reachable)('spec 029 review creation (AC-2, AC-7)', () => {
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

  const rating5 = { rating: 5 as const, text: null, mediaFileAssetIds: [] };

  describe('AC-2: the review is linked to that specific booking', () => {
    it('publishes a review with the rating and text the customer sent', async () => {
      const { scenario, bookingId } = await completed();
      const { review, replayed } = await createReview(
        scenario.customer.userId,
        bookingId,
        { rating: 4, text: 'Arrived on time and did a careful job.', mediaFileAssetIds: [] },
        { key: freshKey(), fingerprint: 'f' },
      );

      expect(replayed).toBe(false);
      expect(review).toMatchObject({
        bookingId,
        rating: 4,
        text: 'Arrived on time and did a careful job.',
        status: 'published',
        providerProfileId: scenario.provider.providerProfileId,
      });
      expect(review.media).toEqual([]);
      expect(review.response).toBeNull();
    });

    it('takes provider and service from the booking, ignoring anything a client might send', async () => {
      const { scenario, bookingId } = await completed();
      const other = await completed();

      // A body carrying a foreign provider/service/author. `ParsedReview` has no such fields, so
      // these are simply dropped — which is the guarantee: there is no interface to abuse.
      const { review } = await createReview(
        scenario.customer.userId,
        bookingId,
        {
          ...rating5,
          // @ts-expect-error — deliberately sending fields the parsed type does not carry.
          providerProfileId: other.scenario.provider.providerProfileId,
          serviceId: other.scenario.serviceId,
          authorUserId: other.scenario.customer.userId,
        },
        { key: freshKey(), fingerprint: 'f' },
      );

      const row = await reviewRowById(review.id);
      expect(row.provider_profile_id).toBe(scenario.provider.providerProfileId);
      expect(row.service_id).toBe(scenario.serviceId);
      expect(row.author_user_id).toBe(scenario.customer.userId);
    });

    it('appears on the provider public list', async () => {
      const { scenario, bookingId } = await completed();
      await createReview(scenario.customer.userId, bookingId, rating5, { key: freshKey(), fingerprint: 'f' });

      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({ rating: 5, providerProfileId: scenario.provider.providerProfileId });
      expect(page.aggregate).toEqual({ average: 5, count: 1 });
    });

    it('accepts a rating-only review', async () => {
      const { scenario, bookingId } = await completed();
      const { review } = await createReview(scenario.customer.userId, bookingId, rating5, {
        key: freshKey(),
        fingerprint: 'f',
      });
      expect(review.text).toBeNull();
      expect(review.status).toBe('published');
    });
  });

  describe('AC-7: one review per booking', () => {
    it('rejects a second review with 409', async () => {
      const { scenario, bookingId } = await completed();
      await createReview(scenario.customer.userId, bookingId, rating5, { key: freshKey(), fingerprint: 'a' });

      await expect(
        createReview(scenario.customer.userId, bookingId, { ...rating5, rating: 1 }, { key: freshKey(), fingerprint: 'b' }),
      ).rejects.toMatchObject({ code: 'REVIEW_ALREADY_EXISTS', status: 409 });

      expect(await countReviews(bookingId)).toBe(1);
    });

    it('is enforced at the database, independent of the application check', async () => {
      const { scenario, bookingId } = await completed();
      const { review } = await createReview(scenario.customer.userId, bookingId, rating5, {
        key: freshKey(),
        fingerprint: 'f',
      });

      // Bypassing every application guard: `reviews_booking_id_uq` must still refuse. The
      // constraint name lives on the driver error, not in the wrapper's message, so this asserts
      // the constraint rather than a string.
      let violation: unknown;
      try {
        await getDb().execute(sql`
          INSERT INTO reviews (booking_id, author_user_id, provider_profile_id, service_id, rating, status,
                               idempotency_key, idempotency_fingerprint)
          VALUES (${bookingId}, ${scenario.customer.userId}, ${scenario.provider.providerProfileId},
                  ${scenario.serviceId}, 1, 'published', ${freshKey()}, 'x')
        `);
      } catch (err) {
        violation = err;
      }
      expect(isUniqueViolation(violation, 'reviews_booking_id_uq')).toBe(true);

      expect(review.id).toBeTruthy();
      expect(await countReviews(bookingId)).toBe(1);
    });
  });

  describe('idempotency', () => {
    it('replays the original on a retry with the same key and fingerprint', async () => {
      const { scenario, bookingId } = await completed();
      const key = freshKey();

      const first = await createReview(scenario.customer.userId, bookingId, rating5, { key, fingerprint: 'f' });
      const second = await createReview(scenario.customer.userId, bookingId, rating5, { key, fingerprint: 'f' });

      expect(second.replayed).toBe(true);
      expect(second.review.id).toBe(first.review.id);
      expect(await countReviews(bookingId)).toBe(1);
    });

    it('rejects the same key with a different body', async () => {
      const { scenario, bookingId } = await completed();
      const key = freshKey();
      await createReview(scenario.customer.userId, bookingId, rating5, { key, fingerprint: 'f' });

      const other = await completed();
      await expect(
        createReview(other.scenario.customer.userId, other.bookingId, rating5, { key, fingerprint: 'f' }),
      ).resolves.toBeTruthy(); // a DIFFERENT author may reuse the same key — scoping is per author.

      await expect(
        createReview(scenario.customer.userId, bookingId, { ...rating5, rating: 1 }, { key, fingerprint: 'different' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });
  });

  describe('media (AC-2)', () => {
    it('attaches ready review_media the customer uploaded for this booking', async () => {
      const { scenario, bookingId } = await completed();
      const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);

      const { review } = await createReview(
        scenario.customer.userId,
        bookingId,
        { ...rating5, mediaFileAssetIds: [assetId] },
        { key: freshKey(), fingerprint: 'f' },
      );

      expect(review.media).toHaveLength(1);
      expect(review.media[0]).toMatchObject({ id: assetId, status: 'ready', visibility: 'public', kind: 'image' });
    });

    it("rejects another booking's asset, and writes no review", async () => {
      const { scenario, bookingId } = await completed();
      const other = await completed();
      const foreign = await uploadReviewMedia(other.scenario.customer.userId, 'customer', other.bookingId);

      await expect(
        createReview(
          scenario.customer.userId,
          bookingId,
          { ...rating5, mediaFileAssetIds: [foreign] },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_MEDIA_ASSET_INVALID', status: 422 });

      expect(await countReviews(bookingId)).toBe(0);
    });

    it('rejects an asset that was uploaded but never finalized (not `ready`)', async () => {
      const { scenario, bookingId } = await completed();
      const pending = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId, { finalize: false });

      await expect(
        createReview(
          scenario.customer.userId,
          bookingId,
          { ...rating5, mediaFileAssetIds: [pending] },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_MEDIA_ASSET_INVALID' });
    });

    it('rejects a soft-deleted asset', async () => {
      const { scenario, bookingId } = await completed();
      const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);
      await getDb().execute(sql`UPDATE file_assets SET deleted_at = clock_timestamp() WHERE id = ${assetId}`);

      await expect(
        createReview(
          scenario.customer.userId,
          bookingId,
          { ...rating5, mediaFileAssetIds: [assetId] },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_MEDIA_ASSET_INVALID' });
    });

    it('rejects an asset of a different context type', async () => {
      const { scenario, bookingId } = await completed();
      // `request_attachment` against the customer's own request — a genuinely valid asset of the
      // wrong kind, which is exactly the confusion the context check exists to catch.
      const wrongContext = await uploadReviewMedia(scenario.customer.userId, 'customer', scenario.requestId, {
        contextType: 'request_attachment',
      });

      await expect(
        createReview(
          scenario.customer.userId,
          bookingId,
          { ...rating5, mediaFileAssetIds: [wrongContext] },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_MEDIA_ASSET_INVALID' });
    });
  });
});
