/**
 * Spec 029 §6 — the `review_media` context policy.
 *
 * Every upload here goes through spec 027's REAL `createUploadTarget`/`finalizeUpload`, because the
 * point of these tests is that the upload policy is what stops a foreign asset existing in the
 * first place. A faked `file_assets` row would prove nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { loadAsset } from '@/lib/files/files-test-support';
import { createReview } from './create';
import { resolveReviewModeration } from './moderation';
import { reviewMediaPolicy } from './media-policy';
import {
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  seedStranger,
  shiftCompletedSince,
  uploadReviewMedia,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('spec 029 review media authorization', () => {
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

  describe('the policy shape', () => {
    it('is public-eligible, images only, capped at five', () => {
      expect(reviewMediaPolicy.publicEligible).toBe(true);
      expect(reviewMediaPolicy.allowedKinds).toEqual(['image']);
      expect(reviewMediaPolicy.maxPerContext).toBe(5);
    });
  });

  describe('canUpload', () => {
    it('allows the booking customer in customer mode, inside the window', async () => {
      const { scenario, bookingId } = await completed();
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.customer.userId, activeMode: 'customer', contextId: bookingId }),
      ).resolves.toBe(true);
    });

    it('refuses the customer in PROVIDER mode', async () => {
      const { scenario, bookingId } = await completed();
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.customer.userId, activeMode: 'provider', contextId: bookingId }),
      ).resolves.toBe(false);
    });

    it("refuses the booking's provider — media belongs to the reviewer", async () => {
      const { scenario, bookingId } = await completed();
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.provider.userId, activeMode: 'customer', contextId: bookingId }),
      ).resolves.toBe(false);
    });

    it('refuses a stranger', async () => {
      const { bookingId } = await completed();
      const stranger = await seedStranger();
      await expect(
        reviewMediaPolicy.canUpload({ userId: stranger.customer.userId, activeMode: 'customer', contextId: bookingId }),
      ).resolves.toBe(false);
    });

    it('refuses before the booking is completed — media cannot be pre-staged', async () => {
      const seeded = await seedConfirmedBooking();
      await expect(
        reviewMediaPolicy.canUpload({
          userId: seeded.scenario.customer.userId,
          activeMode: 'customer',
          contextId: seeded.bookingId,
        }),
      ).resolves.toBe(false);
    });

    it('refuses after the review window closes — and cannot be bolted on later', async () => {
      const { scenario, bookingId } = await completed();
      await shiftCompletedSince(bookingId, 15);
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.customer.userId, activeMode: 'customer', contextId: bookingId }),
      ).resolves.toBe(false);
    });

    it('refuses a missing or malformed context id', async () => {
      const { scenario } = await completed();
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.customer.userId, activeMode: 'customer', contextId: null }),
      ).resolves.toBe(false);
      await expect(
        reviewMediaPolicy.canUpload({ userId: scenario.customer.userId, activeMode: 'customer', contextId: 'nope' }),
      ).resolves.toBe(false);
    });

    it('spec 027 refuses the upload outright for an unauthorized caller', async () => {
      // End-to-end through the real route logic, not just the predicate.
      const { bookingId } = await completed();
      const stranger = await seedStranger();
      await expect(uploadReviewMedia(stranger.customer.userId, 'customer', bookingId)).rejects.toBeTruthy();
    });
  });

  describe('canRead', () => {
    async function published(): Promise<{ scenario: BookingScenario; reviewId: string; assetId: string }> {
      const { scenario, bookingId } = await completed();
      const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);
      const { review } = await createReview(
        scenario.customer.userId,
        bookingId,
        { rating: 5, text: null, mediaFileAssetIds: [assetId] },
        { key: freshKey(), fingerprint: 'f' },
      );
      return { scenario, reviewId: review.id, assetId };
    }

    it('lets anyone read a public ready asset on a visible review', async () => {
      const { assetId } = await published();
      const asset = (await loadAsset(assetId))!;
      const stranger = await seedStranger();

      expect(asset.visibility).toBe('public');
      await expect(
        reviewMediaPolicy.canRead({ userId: stranger.customer.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(true);
    });

    it('STOPS being publicly readable once the review is removed', async () => {
      // AC-8: removing a review takes its photographs down in the same act, with no cascade and no
      // sweep — and because spec 027 re-runs `canRead` on every URL issue, an already-issued link
      // stops working too.
      const { reviewId, assetId } = await published();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');

      await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId,
        decision: 'remove',
        reason: 'Removed after Trust & Safety review.',
        expectedStatus: 'published',
        correlationId: 'c',
      });

      const asset = (await loadAsset(assetId))!;
      const stranger = await seedStranger();
      await expect(
        reviewMediaPolicy.canRead({ userId: stranger.customer.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(false);
    });

    it('still lets the uploader see their own photo after removal', async () => {
      const { scenario, reviewId, assetId } = await published();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');
      await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId,
        decision: 'remove',
        reason: 'Removed after Trust & Safety review.',
        expectedStatus: 'published',
        correlationId: 'c',
      });

      const asset = (await loadAsset(assetId))!;
      await expect(
        reviewMediaPolicy.canRead({ userId: scenario.customer.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(true);
    });

    it('lets the uploader read an asset not yet attached to any review', async () => {
      // The whole window in which they are composing the review.
      const { scenario, bookingId } = await completed();
      const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);
      const asset = (await loadAsset(assetId))!;

      await expect(
        reviewMediaPolicy.canRead({ userId: scenario.customer.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(true);
    });

    it('refuses a stranger an unattached asset', async () => {
      const { scenario, bookingId } = await completed();
      const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);
      const asset = (await loadAsset(assetId))!;
      const stranger = await seedStranger();

      await expect(
        reviewMediaPolicy.canRead({ userId: stranger.customer.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(false);
    });

    it('lets a Trust & Safety admin read it, and AUDITS the read before disclosing', async () => {
      // The realistic moderation case, and the only way this branch is reachable: the review was
      // removed, so the asset is no longer publicly readable, and the admin is not its uploader.
      // (Spec 027's `file_assets_terminal_trg` freezes a `ready` row, so visibility cannot simply
      // be flipped — which is that spec's invariant protecting itself.)
      const { reviewId, assetId } = await published();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');

      await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId,
        decision: 'remove',
        reason: 'Removed after Trust & Safety review.',
        expectedStatus: 'published',
        correlationId: 'c',
      });

      const asset = (await loadAsset(assetId))!;
      await expect(
        reviewMediaPolicy.canRead({
          userId: admin.userId,
          activeMode: 'customer',
          asset,
          correlationId: 'corr-media',
        }),
      ).resolves.toBe(true);

      const rows = await queryRows<{ metadata: Record<string, unknown> }>(
        getDb(),
        sql`SELECT metadata FROM security_events
             WHERE event_type = 'reviews.read_review_media' AND metadata->>'targetId' = ${assetId}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({
        resource: 'reviews',
        action: 'moderate',
        targetType: 'file_asset',
        correlationId: 'corr-media',
      });
    });

    it('refuses an admin WITHOUT the moderate permission', async () => {
      const { reviewId, assetId } = await published();
      const remover = await registerAdmin();
      await grantRole(remover, 'trust_safety_admin');
      await resolveReviewModeration({
        adminUserId: remover.userId,
        reviewId,
        decision: 'remove',
        reason: 'Removed after Trust & Safety review.',
        expectedStatus: 'published',
        correlationId: 'c',
      });

      const finance = await registerAdmin();
      await grantRole(finance, 'finance_admin');
      const asset = (await loadAsset(assetId))!;

      await expect(
        reviewMediaPolicy.canRead({ userId: finance.userId, activeMode: 'customer', asset }),
      ).resolves.toBe(false);
    });
  });
});
