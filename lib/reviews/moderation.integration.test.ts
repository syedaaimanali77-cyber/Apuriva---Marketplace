/**
 * Spec 029 §6 — AC-4, AC-5, AC-8, AC-9: flagging, the queue, resolution and the removal invariant.
 *
 * This is the file that makes the spec's central promise observable: a flag is a request for a
 * human to look, never a takedown, and a legitimate negative review is simply a review.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { createReview } from './create';
import { createReviewReport } from './report';
import { getProviderRatingAggregate } from './aggregate';
import { listModerationQueue, resolveReviewModeration, REVIEW_MODERATION_EVENT_TYPE } from './moderation';
import { listProviderReviews } from './read';
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
  type TestAdmin,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();
const PAGE = { limit: 50, offset: 0 };
const REASON = 'Reviewed by Trust & Safety after a report.';

describe.skipIf(!reachable)('spec 029 moderation (AC-4, AC-5, AC-8, AC-9)', () => {
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

  async function review(text: string | null, rating: 1 | 2 | 3 | 4 | 5 = 5) {
    const { scenario, bookingId } = await completed();
    const { review: created } = await createReview(
      scenario.customer.userId,
      bookingId,
      { rating, text, mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    return { scenario, bookingId, review: created };
  }

  async function trustSafetyAdmin(): Promise<TestAdmin> {
    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');
    return admin;
  }

  // -------------------------------------------------------------------------
  // AC-4 — flagged, but never hidden
  // -------------------------------------------------------------------------
  describe('AC-4: a flagged review is queued WITHOUT being hidden', () => {
    it('flags a signal-matching review and still returns it on the public list', async () => {
      const { scenario, review: created } = await review('Call me on 0300 1234567 and skip the platform.');

      expect(created.status).toBe('flagged');
      expect((await reviewRowById(created.id)).flag_signals).toEqual(['contact_sharing']);

      // The whole point: publicly visible, exactly like a published review.
      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(created.id);
      expect(page.total).toBe(1);
    });

    it('carries no status field onto the public surface at all', async () => {
      const { scenario, review: created } = await review('This was absolute shit work honestly.');
      expect(created.status).toBe('flagged');

      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      // `PublicReviewDto` has no `status`, so a reader cannot tell flagged from published.
      expect(page.items[0]).not.toHaveProperty('status');
      expect(Object.keys(page.items[0]!)).toEqual(
        expect.arrayContaining(['id', 'providerProfileId', 'serviceId', 'rating', 'text', 'media', 'response', 'createdAt']),
      );
      expect(Object.keys(page.items[0]!)).not.toContain('flagSignals');
    });

    it('still counts toward the rating aggregate while it waits', async () => {
      // Deliberate: excluding it would be an automatic, invisible ranking penalty applied by a
      // heuristic — exactly what master §52 forbids (§8 risk 7).
      const { scenario, review: created } = await review('Email me at bob@example.com', 1);
      expect(created.status).toBe('flagged');
      expect(await getProviderRatingAggregate(scenario.provider.providerProfileId)).toEqual({ average: 1, count: 1 });
    });

    it('appears in the moderation queue', async () => {
      const { review: created } = await review('buy buy buy buy buy buy buy buy buy buy');
      const queue = await listModerationQueue(PAGE);
      expect(queue.items.map((r) => r.id)).toContain(created.id);
      expect(queue.items.find((r) => r.id === created.id)!.flagSignals).toContain('spam_shape');
    });

    it('NO automated path can produce `removed` — the database refuses it', async () => {
      const { review: created } = await review('A perfectly ordinary review of a job.');

      // Every field a heuristic could plausibly set, without the human trio the check requires.
      await expect(
        getDb().execute(sql`UPDATE reviews SET status = 'removed' WHERE id = ${created.id}`),
      ).rejects.toThrow();

      await expect(
        getDb().execute(
          sql`UPDATE reviews SET status = 'removed', removal_reason = 'spam detector said so' WHERE id = ${created.id}`,
        ),
      ).rejects.toThrow();

      expect((await reviewRowById(created.id)).status).toBe('published');
    });
  });

  // -------------------------------------------------------------------------
  // AC-5 — legitimate criticism is never suppressed
  // -------------------------------------------------------------------------
  describe('AC-5: a legitimate negative review stays published and visible', () => {
    it.each([1, 2] as const)('publishes a %i-star review with clean text', async (rating) => {
      const { scenario, review: created } = await review(
        'He turned up two hours late, did half the job and would not answer afterwards.',
        rating,
      );

      expect(created.status).toBe('published');
      expect((await reviewRowById(created.id)).flag_signals).toEqual([]);

      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(created.id);
      expect(page.aggregate).toEqual({ average: rating, count: 1 });
    });

    it('does not put it in the moderation queue', async () => {
      const { review: created } = await review('Poor work and a rude attitude. Would not book again.', 1);
      const queue = await listModerationQueue(PAGE);
      expect(queue.items.map((r) => r.id)).not.toContain(created.id);
    });

    it('a five-star review with the same signal IS flagged — the rating is never the trigger', async () => {
      const bad = await review('Brilliant! Call me on 0300 1234567 for a deal.', 5);
      expect(bad.review.status).toBe('flagged');

      const good = await review('Brilliant work, thorough and tidy throughout.', 5);
      expect(good.review.status).toBe('published');
    });
  });

  // -------------------------------------------------------------------------
  // AC-8 — resolution
  // -------------------------------------------------------------------------
  describe('AC-8: removal', () => {
    it('hides the review, resolves its reports and writes one audit event', async () => {
      const { scenario, review: created } = await review('Email me at bob@example.com');
      const reporter = await seedStranger();
      await createReviewReport(reporter.customer.userId, created.id, { reason: 'spam', details: null }, {
        key: freshKey(),
        fingerprint: 'f',
      });

      const admin = await trustSafetyAdmin();
      const resolved = await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId: created.id,
        decision: 'remove',
        reason: REASON,
        expectedStatus: 'flagged',
        correlationId: 'corr-remove',
      });

      expect(resolved.status).toBe('removed');
      expect(resolved.removalReason).toBe(REASON);
      expect(resolved.moderatedAt).not.toBeNull();

      // Gone from every public read and from the aggregate.
      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).not.toContain(created.id);
      expect(page.total).toBe(0);
      expect(await getProviderRatingAggregate(scenario.provider.providerProfileId)).toEqual({ average: 0, count: 0 });

      // Its reports are resolved, by name.
      const reports = await reportRowsFor(created.id);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ status: 'resolved', resolved_by_admin_id: admin.adminProfileId });

      // Exactly one audit event, carrying the actor, the target and the reason.
      const events = await queryRows<{ user_id: string; metadata: Record<string, unknown> }>(
        getDb(),
        sql`SELECT user_id, metadata FROM security_events
             WHERE event_type = ${REVIEW_MODERATION_EVENT_TYPE}
               AND metadata->>'targetId' = ${created.id}`,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.user_id).toBe(admin.userId);
      expect(events[0]!.metadata).toMatchObject({
        resource: 'reviews',
        action: 'moderate',
        targetType: 'review',
        reason: REASON,
        correlationId: 'corr-remove',
      });
      expect(events[0]!.metadata.actorRoles).toContain('trust_safety_admin');
    });

    it('keeps a review: clears the flag, dismisses the reports, changes nothing visible', async () => {
      const { scenario, review: created } = await review('This was shit work, frankly.', 1);
      expect(created.status).toBe('flagged');

      const admin = await trustSafetyAdmin();
      const resolved = await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId: created.id,
        decision: 'keep',
        reason: 'Rude but truthful. Criticism is not a violation.',
        expectedStatus: 'flagged',
        correlationId: 'corr-keep',
      });

      expect(resolved.status).toBe('published');
      expect(resolved.removalReason).toBeNull();

      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(created.id);

      // And it leaves the queue, so a human is not asked twice.
      expect((await listModerationQueue(PAGE)).items.map((r) => r.id)).not.toContain(created.id);
    });

    it('reinstates a removed review — master §68 appeal mechanism', async () => {
      const { scenario, review: created } = await review('Email me at bob@example.com');
      const admin = await trustSafetyAdmin();

      await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId: created.id,
        decision: 'remove',
        reason: REASON,
        expectedStatus: 'flagged',
        correlationId: 'c1',
      });

      const reinstated = await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId: created.id,
        decision: 'reinstate',
        reason: 'Appeal upheld — the contact detail was the reviewer own number.',
        expectedStatus: 'removed',
        correlationId: 'c2',
      });

      expect(reinstated.status).toBe('published');
      expect(reinstated.removalReason).toBeNull();
      const page = await listProviderReviews(scenario.provider.providerProfileId, PAGE);
      expect(page.items.map((r) => r.id)).toContain(created.id);
    });

    it('rejects a stale expectedStatus with 409 so two admins cannot overwrite each other', async () => {
      const { review: created } = await review('Email me at bob@example.com');
      const first = await trustSafetyAdmin();
      const second = await trustSafetyAdmin();

      await resolveReviewModeration({
        adminUserId: first.userId,
        reviewId: created.id,
        decision: 'keep',
        reason: 'Looked fine to me on closer reading.',
        expectedStatus: 'flagged',
        correlationId: 'c1',
      });

      await expect(
        resolveReviewModeration({
          adminUserId: second.userId,
          reviewId: created.id,
          decision: 'remove',
          reason: REASON,
          // The status this admin was shown — now stale.
          expectedStatus: 'flagged',
          correlationId: 'c2',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

      expect((await reviewRowById(created.id)).status).toBe('published');
    });

    it('a removal always names a human admin and an instant', async () => {
      const { review: created } = await review('Email me at bob@example.com');
      const admin = await trustSafetyAdmin();

      await resolveReviewModeration({
        adminUserId: admin.userId,
        reviewId: created.id,
        decision: 'remove',
        reason: REASON,
        expectedStatus: 'flagged',
        correlationId: 'c',
      });

      const row = await reviewRowById(created.id);
      expect(row.moderated_by_admin_id).toBe(admin.adminProfileId);
      expect(row.moderated_at).not.toBeNull();
      expect(row.removal_reason).toBe(REASON);
    });
  });
});
