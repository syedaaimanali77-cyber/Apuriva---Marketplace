import { describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createReview } from '@/lib/reviews/create';
import { createReviewReport } from '@/lib/reviews/report';
import { createReviewResponse } from '@/lib/reviews/response';
import { listModerationQueue, resolveReviewModeration } from '@/lib/reviews/moderation';
import { getProviderRatingAggregate } from '@/lib/reviews/aggregate';
import { listProviderReviews } from '@/lib/reviews/read';
import {
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  seedConfirmedBooking,
  seedStranger,
  uploadReviewMedia,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
} from '@/lib/reviews/reviews-test-support';

const dbReachable = await isDatabaseReachable();
const PAGE = { limit: 20, offset: 0 };

/**
 * Spec 029 §6 "End-to-end (Vitest)".
 *
 * `e2e/*.spec.ts` is a configured VITEST pattern (vitest.config.ts `include`), not Playwright —
 * there is no browser runner in this repository and this spec does not add one. What makes this
 * end-to-end rather than another integration test is that it walks the whole journey in order:
 * complete a booking → review it with a photo → provider replies → someone reports it → Trust &
 * Safety decides → the outcome is visible everywhere it should be and nowhere it should not.
 */
describe.skipIf(!dbReachable)('reviews and ratings, end to end (spec 029)', { timeout: 120_000 }, () => {
  useTemporaryStorageDir();

  it('runs the full journey, keeping the review visible until a human decides otherwise', async () => {
    useMessagingIntegration();
    useReviewsIntegration();

    // ---------------------------------------------------------------------
    // 1. A booking is genuinely completed, through spec 020's own path.
    // ---------------------------------------------------------------------
    const { scenario, bookingId } = await seedConfirmedBooking();
    await completeBookingForReview(scenario, bookingId);
    resetRateLimitState();

    // ---------------------------------------------------------------------
    // 2. The customer uploads a photo through spec 027 and publishes a review.
    // ---------------------------------------------------------------------
    const assetId = await uploadReviewMedia(scenario.customer.userId, 'customer', bookingId);
    const { review } = await createReview(
      scenario.customer.userId,
      bookingId,
      {
        rating: 2,
        text: 'Arrived late and left without clearing up. Not what was agreed.',
        mediaFileAssetIds: [assetId],
      },
      { key: freshKey(), fingerprint: 'e2e' },
    );

    // Clean criticism: published, not flagged (AC-5).
    expect(review.status).toBe('published');
    expect(review.media).toHaveLength(1);

    let page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items.map((r) => r.id)).toEqual([review.id]);
    expect(page.aggregate).toEqual({ average: 2, count: 1 });

    // ---------------------------------------------------------------------
    // 3. The provider exercises their one right of reply (AC-3).
    // ---------------------------------------------------------------------
    await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      review.id,
      { text: 'We are sorry — the previous job overran and we should have called ahead.' },
      { key: freshKey(), fingerprint: 'e2e' },
    );

    page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items[0]!.response!.text).toContain('should have called ahead');

    // A second reply is refused; the first is never silently replaced.
    await expect(
      createReviewResponse(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        review.id,
        { text: 'On reflection, let me put that another way entirely.' },
        { key: freshKey(), fingerprint: 'e2e-2' },
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_ALREADY_EXISTS' });

    // ---------------------------------------------------------------------
    // 4. Someone reports it. THE REVIEW DOES NOT MOVE (AC-6).
    // ---------------------------------------------------------------------
    const reporter = await seedStranger();
    await createReviewReport(
      reporter.customer.userId,
      review.id,
      { reason: 'false_information', details: 'I believe this account is not accurate.' },
      { key: freshKey(), fingerprint: 'e2e' },
    );

    page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items.map((r) => r.id)).toEqual([review.id]);
    expect(page.aggregate).toEqual({ average: 2, count: 1 });

    // It is queued for a human, and carries no verdict on the public surface.
    const queue = await listModerationQueue({ limit: 50, offset: 0 });
    expect(queue.items.map((r) => r.id)).toContain(review.id);
    expect(page.items[0]).not.toHaveProperty('status');

    // ---------------------------------------------------------------------
    // 5. Trust & Safety reads it and decides to KEEP it (AC-5).
    // ---------------------------------------------------------------------
    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');

    const kept = await resolveReviewModeration({
      adminUserId: admin.userId,
      reviewId: review.id,
      decision: 'keep',
      reason: 'Negative but plausible and on-topic. Criticism is not a violation.',
      expectedStatus: 'flagged',
      correlationId: 'e2e-keep',
    });
    expect(kept.status).toBe('published');

    page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items.map((r) => r.id)).toEqual([review.id]);
    expect((await listModerationQueue({ limit: 50, offset: 0 })).items.map((r) => r.id)).not.toContain(review.id);

    // ---------------------------------------------------------------------
    // 6. A later, different decision removes it — and everything follows (AC-8).
    // ---------------------------------------------------------------------
    const removed = await resolveReviewModeration({
      adminUserId: admin.userId,
      reviewId: review.id,
      decision: 'remove',
      reason: 'On a second look the reviewer confirmed this was the wrong provider.',
      expectedStatus: 'published',
      correlationId: 'e2e-remove',
    });
    expect(removed.status).toBe('removed');

    page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(await getProviderRatingAggregate(scenario.provider.providerProfileId)).toEqual({ average: 0, count: 0 });

    // ---------------------------------------------------------------------
    // 7. And the appeal path puts it back (master §68).
    // ---------------------------------------------------------------------
    const reinstated = await resolveReviewModeration({
      adminUserId: admin.userId,
      reviewId: review.id,
      decision: 'reinstate',
      reason: 'Appeal upheld: the booking reference was right after all.',
      expectedStatus: 'removed',
      correlationId: 'e2e-reinstate',
    });
    expect(reinstated.status).toBe('published');

    page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items.map((r) => r.id)).toEqual([review.id]);
    expect(page.items[0]!.media).toHaveLength(1);
    expect(page.aggregate).toEqual({ average: 2, count: 1 });
  });
});
