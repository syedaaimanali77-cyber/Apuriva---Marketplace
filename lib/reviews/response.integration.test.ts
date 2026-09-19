/**
 * Spec 029 §6 — AC-3: the provider's single, immutable reply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { ApiRouteError } from '@/lib/api/errors';
import { createReview } from './create';
import { createReviewResponse } from './response';
import { resolveReviewModeration } from './moderation';
import { listProviderReviews } from './read';
import {
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();
const PAGE = { limit: 20, offset: 0 };
const REPLY = 'Thanks for the feedback — we have changed how we schedule the last job of the day.';

describe.skipIf(!reachable)('spec 029 provider response (AC-3)', () => {
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

  async function reviewed(): Promise<{ scenario: BookingScenario; reviewId: string }> {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 2, text: 'Late and not especially tidy.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    return { scenario: seeded.scenario, reviewId: review.id };
  }

  it('attaches one response, visible to every reader alongside the review', async () => {
    const { scenario, reviewId } = await reviewed();

    const { response, replayed } = await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      reviewId,
      { text: REPLY },
      { key: freshKey(), fingerprint: 'f' },
    );

    expect(replayed).toBe(false);
    expect(response).toMatchObject({ reviewId, text: REPLY, status: 'published' });

    const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items[0]!.response).toMatchObject({ text: REPLY });
  });

  it('rejects a second response with 409', async () => {
    const { scenario, reviewId } = await reviewed();
    await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      reviewId,
      { text: REPLY },
      { key: freshKey(), fingerprint: 'a' },
    );

    await expect(
      createReviewResponse(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        reviewId,
        { text: 'Actually, let me put that differently entirely.' },
        { key: freshKey(), fingerprint: 'b' },
      ),
    ).rejects.toMatchObject({ code: 'RESPONSE_ALREADY_EXISTS', status: 409 });

    // The first reply is untouched — a response is never silently replaced.
    const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items[0]!.response!.text).toBe(REPLY);
  });

  it('two simultaneous responses produce exactly one, and the loser gets 409', async () => {
    const { scenario, reviewId } = await reviewed();

    const attempt = (suffix: string) =>
      createReviewResponse(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        reviewId,
        { text: `${REPLY} ${suffix}` },
        { key: freshKey(), fingerprint: suffix },
      );

    const results = await Promise.allSettled([attempt('one'), attempt('two')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ApiRouteError).code).toBe('RESPONSE_ALREADY_EXISTS');
  });

  it('replays an idempotent retry rather than conflicting', async () => {
    const { scenario, reviewId } = await reviewed();
    const key = freshKey();

    const first = await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      reviewId,
      { text: REPLY },
      { key, fingerprint: 'f' },
    );
    const second = await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      reviewId,
      { text: REPLY },
      { key, fingerprint: 'f' },
    );

    expect(second.replayed).toBe(true);
    expect(second.response.id).toBe(first.response.id);
  });

  describe('ownership', () => {
    it('gives a provider who owns a DIFFERENT profile 404, not 403', async () => {
      const { reviewId } = await reviewed();
      const other = await seedConfirmedBooking();

      await expect(
        createReviewResponse(
          other.scenario.provider.userId,
          other.scenario.provider.providerProfileId,
          reviewId,
          { text: REPLY },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND', status: 404 });
    });

    it('refuses a profile id that does not match the review, even from the right user', async () => {
      // Belt and braces: the route proves profile ownership, this proves the profile is the one
      // the review is about. A caller passing someone else's profile id gets nowhere.
      const { scenario, reviewId } = await reviewed();
      const other = await seedConfirmedBooking();

      await expect(
        createReviewResponse(
          scenario.provider.userId,
          other.scenario.provider.providerProfileId,
          reviewId,
          { text: REPLY },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    });

    it('gives an unknown review id 404', async () => {
      const { scenario } = await reviewed();
      await expect(
        createReviewResponse(
          scenario.provider.userId,
          scenario.provider.providerProfileId,
          '00000000-0000-4000-8000-000000000000',
          { text: REPLY },
          { key: freshKey(), fingerprint: 'f' },
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    });
  });

  it('refuses to respond to a removed review', async () => {
    const { scenario, reviewId } = await reviewed();
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

    await expect(
      createReviewResponse(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        reviewId,
        { text: REPLY },
        { key: freshKey(), fingerprint: 'f' },
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_NOT_RESPONDABLE', status: 422 });
  });

  it('flags an abusive reply without hiding it — the same rule a review gets', async () => {
    const { scenario, reviewId } = await reviewed();
    const { response } = await createReviewResponse(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      reviewId,
      { text: 'You are talking absolute shit and everyone knows it.' },
      { key: freshKey(), fingerprint: 'f' },
    );

    expect(response.status).toBe('flagged');
    const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
    expect(page.items[0]!.response).not.toBeNull();
  });
});
