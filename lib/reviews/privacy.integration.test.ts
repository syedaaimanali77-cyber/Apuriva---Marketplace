/**
 * Spec 029 §6 — AC-10: what a user's own data export contains, and what it must never contain.
 *
 * The negative assertions matter more than the positive ones here. A reporter whose identity can
 * leak to the reviewed provider will not report, and a flag signal is a moderation signal rather
 * than the user's data — so both must be absent from every export, whoever asks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { generateExportPayload } from '@/lib/privacy/export';
import { createReview } from './create';
import { createReviewReport } from './report';
import { createReviewResponse } from './response';
import {
  completeBookingForReview,
  freshKey,
  isDatabaseReachable,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  seedStranger,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('spec 029 privacy and export (AC-10)', () => {
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

  it("includes the reviews a user authored, with rating, text and status", async () => {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 3, text: 'Reasonable work, a little late.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );

    const payload = await generateExportPayload(seeded.scenario.customer.userId);
    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]).toMatchObject({
      id: review.id,
      bookingId: seeded.bookingId,
      rating: 3,
      text: 'Reasonable work, a little late.',
      status: 'published',
    });
  });

  it('includes the responses a provider wrote', async () => {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 2, text: 'Not the tidiest job I have had.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    await createReviewResponse(
      seeded.scenario.provider.userId,
      seeded.scenario.provider.providerProfileId,
      review.id,
      { text: 'Sorry about that — we have changed how we finish up.' },
      { key: freshKey(), fingerprint: 'f' },
    );

    const payload = await generateExportPayload(seeded.scenario.provider.userId);
    expect(payload.reviewResponses).toHaveLength(1);
    expect(payload.reviewResponses[0]).toMatchObject({ reviewId: review.id, status: 'published' });
  });

  it('includes the reports a user FILED', async () => {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 1, text: 'Email me at bob@example.com', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );

    const reporter = await seedStranger();
    await createReviewReport(
      reporter.customer.userId,
      review.id,
      { reason: 'spam', details: null },
      { key: freshKey(), fingerprint: 'f' },
    );

    const reporterPayload = await generateExportPayload(reporter.customer.userId);
    expect(reporterPayload.reviewReports).toHaveLength(1);
    expect(reporterPayload.reviewReports[0]).toMatchObject({ reviewId: review.id, reason: 'spam', status: 'open' });
  });

  it("does NOT include a report filed by someone else on the author's own review", async () => {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 1, text: 'Email me at bob@example.com', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );

    const reporter = await seedStranger();
    await createReviewReport(
      reporter.customer.userId,
      review.id,
      { reason: 'spam', details: 'Looks like an advert to me.' },
      { key: freshKey(), fingerprint: 'f' },
    );

    // The author exports their own data: the review is theirs, the report about it is not.
    const authorPayload = await generateExportPayload(seeded.scenario.customer.userId);
    expect(authorPayload.reviews).toHaveLength(1);
    expect(authorPayload.reviewReports).toHaveLength(0);

    const serialized = JSON.stringify(authorPayload);
    expect(serialized).not.toContain(reporter.customer.userId);
    expect(serialized).not.toContain('Looks like an advert to me.');
  });

  it('never exports flag signals or moderation fields', async () => {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      // Deliberately trips `contact_sharing`, so there IS a signal that could leak.
      { rating: 5, text: 'Ring me on 0300 1234567 next time.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    expect(review.status).toBe('flagged');

    const payload = await generateExportPayload(seeded.scenario.customer.userId);
    const exported = payload.reviews[0]!;

    expect(Object.keys(exported).sort()).toEqual(['bookingId', 'createdAt', 'id', 'rating', 'status', 'text']);
    expect(JSON.stringify(payload)).not.toContain('contact_sharing');
    expect(JSON.stringify(payload)).not.toContain('flagSignals');
    expect(JSON.stringify(payload)).not.toContain('removalReason');
  });

  it('tells an author their review was removed, which is information about them', async () => {
    const { registerAdmin, grantRole } = await import('./reviews-test-support');
    const { resolveReviewModeration } = await import('./moderation');

    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 1, text: 'Email me at bob@example.com', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );

    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');
    await resolveReviewModeration({
      adminUserId: admin.userId,
      reviewId: review.id,
      decision: 'remove',
      reason: 'Contains contact details on a public surface.',
      expectedStatus: 'flagged',
      correlationId: 'c',
    });

    const payload = await generateExportPayload(seeded.scenario.customer.userId);
    expect(payload.reviews[0]!.status).toBe('removed');
    // But NOT why, and not who decided: that is moderation data (§4).
    expect(JSON.stringify(payload)).not.toContain('Contains contact details on a public surface.');
  });
});
