/**
 * Spec 029 §6 — AC-6: reporting a review, and the invariant that a report changes nothing a reader
 * can see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createReview } from './create';
import { createReviewReport } from './report';
import { listModerationQueue, resolveReviewModeration } from './moderation';
import { getProviderRatingAggregate } from './aggregate';
import { listProviderReviews } from './read';
import { MAX_REPORTS_PER_WINDOW } from './limits';
import {
  completeBookingForReview,
  freshKey,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  reportRowsFor,
  resetReviewsIntegrationForTests,
  reviewRowById,
  seedConfirmedBooking,
  seedStranger,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();
const PAGE = { limit: 50, offset: 0 };

describe.skipIf(!reachable)('spec 029 review reporting (AC-6)', () => {
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
      { rating: 1, text: 'Genuinely poor work and no apology afterwards.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    return { scenario: seeded.scenario, reviewId: review.id };
  }

  const spam = { reason: 'spam' as const, details: null };

  it('creates a report and queues the review', async () => {
    const { reviewId } = await reviewed();
    const reporter = await seedStranger();

    const { report, replayed } = await createReviewReport(reporter.customer.userId, reviewId, spam, {
      key: freshKey(),
      fingerprint: 'f',
    });

    expect(replayed).toBe(false);
    expect(report).toMatchObject({ reviewId, reason: 'spam', status: 'open' });
    expect((await listModerationQueue(PAGE)).items.map((r) => r.id)).toContain(reviewId);
  });

  describe('AC-6: reporting NEVER changes visibility', () => {
    it('leaves the review on the public list and in the aggregate', async () => {
      const { scenario, reviewId } = await reviewed();
      const reporter = await seedStranger();
      await createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' });

      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(reviewId);
      expect(page.total).toBe(1);
      expect(await getProviderRatingAggregate(scenario.provider.providerProfileId)).toEqual({ average: 1, count: 1 });
    });

    it('moves the review to `flagged`, which is a WIDENING change only', async () => {
      const { reviewId } = await reviewed();
      expect((await reviewRowById(reviewId)).status).toBe('published');

      const reporter = await seedStranger();
      await createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' });

      expect((await reviewRowById(reviewId)).status).toBe('flagged');
    });

    it('many reports still do not remove it — a brigade produces a queue entry, not a takedown', async () => {
      const { scenario, reviewId } = await reviewed();

      for (let i = 0; i < 8; i += 1) {
        const reporter = await seedStranger();
        await createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' });
      }

      expect(await reportRowsFor(reviewId)).toHaveLength(8);
      expect((await reviewRowById(reviewId)).status).toBe('flagged');
      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(reviewId);
      // Seeds eight complete accounts through the real 015->021 path, so it is inherently slow;
      // an explicit budget keeps it from flaking on the 15s default under full-suite contention.
    }, 120_000);
  });

  describe('duplicates', () => {
    it('returns the same report when the same user reports twice', async () => {
      const { reviewId } = await reviewed();
      const reporter = await seedStranger();

      const first = await createReviewReport(reporter.customer.userId, reviewId, spam, {
        key: freshKey(),
        fingerprint: 'f',
      });
      const second = await createReviewReport(
        reporter.customer.userId,
        reviewId,
        { reason: 'offensive', details: null },
        { key: freshKey(), fingerprint: 'g' },
      );

      expect(second.replayed).toBe(true);
      expect(second.report.id).toBe(first.report.id);
      // The original reason stands: a re-file does not let a reporter rewrite their statement.
      expect(second.report.reason).toBe('spam');
      expect(await reportRowsFor(reviewId)).toHaveLength(1);
    });

    it('is enforced at the database', async () => {
      const { reviewId } = await reviewed();
      const reporter = await seedStranger();
      await createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' });

      await expect(
        getDb().execute(sql`
          INSERT INTO review_reports (review_id, reporter_user_id, reason, status, idempotency_key, idempotency_fingerprint)
          VALUES (${reviewId}, ${reporter.customer.userId}, 'offensive', 'open', ${freshKey()}, 'x')
        `),
      ).rejects.toThrow();
    });
  });

  describe('who may report', () => {
    it('rejects the author reporting their own review', async () => {
      const { scenario, reviewId } = await reviewed();
      await expect(
        createReviewReport(scenario.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' }),
      ).rejects.toMatchObject({ code: 'CANNOT_REPORT_OWN_REVIEW', status: 422 });
    });

    it('allows the reviewed provider to report — they are not the author', async () => {
      const { scenario, reviewId } = await reviewed();
      const { report } = await createReviewReport(
        scenario.provider.userId,
        reviewId,
        { reason: 'false_information', details: 'The job described never took place.' },
        { key: freshKey(), fingerprint: 'f' },
      );
      expect(report.status).toBe('open');
    });

    it('gives an unknown review id 404', async () => {
      const reporter = await seedStranger();
      await expect(
        createReviewReport(reporter.customer.userId, '00000000-0000-4000-8000-000000000000', spam, {
          key: freshKey(),
          fingerprint: 'f',
        }),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND', status: 404 });
    });

    it('hides a removed review from reporters, so a moderation outcome does not leak', async () => {
      const { reviewId } = await reviewed();
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

      const reporter = await seedStranger();
      await expect(
        createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' }),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    });
  });

  it('caps one user at 20 reports per 24 hours', async () => {
    const reporter = await seedStranger();

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i += 1) {
      const { reviewId } = await reviewed();
      await createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' });
    }

    const { reviewId } = await reviewed();
    await expect(
      createReviewReport(reporter.customer.userId, reviewId, spam, { key: freshKey(), fingerprint: 'f' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  }, 120_000);
});
