/**
 * Spec 029 §6 — AC-1: what makes a booking reviewable, and what does not.
 *
 * Every booking here is driven through the REAL spec 015→021 path and completed through spec 020's
 * own `completeBooking`, so the `in_progress -> completed` history row eligibility depends on is
 * genuine rather than inserted by a fixture.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { createReview } from './create';
import { resolveReviewEligibility } from './eligibility';
import { getBookingReviewState } from './read';
import {
  completeBookingForReview,
  freshKey,
  isDatabaseReachable,
  resetReviewsIntegrationForTests,
  seedConfirmedBooking,
  seedStranger,
  shiftCompletedSince,
  useMessagingIntegration,
  useReviewsIntegration,
  useTemporaryStorageDir,
  type BookingScenario,
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('spec 029 review eligibility (AC-1)', () => {
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

  const body = { rating: 5 as const, text: null, mediaFileAssetIds: [] };

  it('rejects a booking that has never reached completed', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    const eligibility = await resolveReviewEligibility(scenario.customer.userId, bookingId);
    expect(eligibility).toMatchObject({ eligible: false, reason: 'not_completed', completedAt: null });

    await expect(
      createReview(scenario.customer.userId, bookingId, body, { key: freshKey(), fingerprint: 'f' }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_ELIGIBLE_FOR_REVIEW', status: 422 });
  });

  it('accepts a booking that has reached completed', async () => {
    const { scenario, bookingId } = await completed();

    const eligibility = await resolveReviewEligibility(scenario.customer.userId, bookingId);
    expect(eligibility).toMatchObject({ eligible: true, reason: null });
    expect(eligibility!.completedAt).not.toBeNull();
    expect(eligibility!.providerProfileId).toBe(scenario.provider.providerProfileId);

    const { review } = await createReview(scenario.customer.userId, bookingId, body, {
      key: freshKey(),
      fingerprint: 'f',
    });
    expect(review.status).toBe('published');
  });

  /**
   * The defect this spec was written to avoid. Spec 021's sweep moves a `completed` booking to
   * `protected` within a minute and to `settled` 48 hours later, so a rule keyed on the literal
   * status would give most customers a review window about one minute wide.
   */
  it.each([
    // The two statuses actually reachable from `completed` in the seeded graph: spec 021's
    // protection (within a minute of completion) and spec 022's refund. `settled` is reached from
    // `protected`, so it is covered by the second row's follow-on step.
    ['protected', null],
    ['protected', 'settled'],
    ['refunded', null],
  ] as const)('still accepts a booking that completed and is now %s%s', async (laterStatus, thenStatus) => {
    const { scenario, bookingId } = await completed();

    // Moved through the REAL seeded graph, so spec 003's `enforce_status_transition` trigger has
    // to accept it — a fixture that forced an unreachable status would prove nothing. The
    // `completed` history row survives either way, and that is what eligibility reads.
    await getDb().execute(sql`UPDATE bookings SET status = ${laterStatus} WHERE id = ${bookingId}`);
    if (thenStatus) {
      await getDb().execute(sql`UPDATE bookings SET status = ${thenStatus} WHERE id = ${bookingId}`);
    }

    const eligibility = await resolveReviewEligibility(scenario.customer.userId, bookingId);
    expect(eligibility).toMatchObject({ eligible: true, reason: null });

    const { review } = await createReview(scenario.customer.userId, bookingId, body, {
      key: freshKey(),
      fingerprint: 'f',
    });
    expect(review.id).toBeTruthy();
  });

  it('rejects a booking that was cancelled without ever completing', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    // The status is set directly rather than through `applyBookingTransition`: `-> cancelled` is
    // spec 023's transition to own and register, and this spec must not reach into another spec's
    // lifecycle to set up a fixture. What matters here is only that no `completed` history row
    // exists, which is exactly what eligibility reads.
    await getDb().execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId}`);

    await expect(
      createReview(scenario.customer.userId, bookingId, body, { key: freshKey(), fingerprint: 'f' }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_ELIGIBLE_FOR_REVIEW' });
  });

  describe('the review window', () => {
    it('is open inside it and reports a closing instant', async () => {
      const { scenario, bookingId } = await completed();
      const state = await getBookingReviewState(scenario.customer.userId, bookingId);
      expect(state.eligible).toBe(true);
      expect(state.windowClosesAt).not.toBeNull();
      // 14 days out, give or take the seconds this test takes to run.
      const days = (Date.parse(state.windowClosesAt!) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('closes after REVIEW_WINDOW_DAYS, enforced server-side', async () => {
      const { scenario, bookingId } = await completed();
      await shiftCompletedSince(bookingId, 15);

      const state = await getBookingReviewState(scenario.customer.userId, bookingId);
      expect(state).toMatchObject({ eligible: false, reason: 'window_closed' });

      await expect(
        createReview(scenario.customer.userId, bookingId, body, { key: freshKey(), fingerprint: 'f' }),
      ).rejects.toMatchObject({ code: 'REVIEW_WINDOW_CLOSED', status: 422 });
    });

    it('is still open one day before it closes', async () => {
      const { scenario, bookingId } = await completed();
      await shiftCompletedSince(bookingId, 13);
      expect(await resolveReviewEligibility(scenario.customer.userId, bookingId)).toMatchObject({ eligible: true });
    });
  });

  describe('who may review', () => {
    it('refuses the provider — they are a participant, but never the author', async () => {
      const { scenario, bookingId } = await completed();

      const state = await getBookingReviewState(scenario.provider.userId, bookingId);
      expect(state).toMatchObject({ eligible: false, reason: 'not_customer' });

      await expect(
        createReview(scenario.provider.userId, bookingId, body, { key: freshKey(), fingerprint: 'f' }),
      ).rejects.toMatchObject({ code: 'BOOKING_NOT_ELIGIBLE_FOR_REVIEW' });
    });

    it('gives a stranger 404, indistinguishable from a booking that does not exist', async () => {
      const { bookingId } = await completed();
      const stranger = await seedStranger();

      expect(await resolveReviewEligibility(stranger.customer.userId, bookingId)).toBeNull();
      await expect(
        createReview(stranger.customer.userId, bookingId, body, { key: freshKey(), fingerprint: 'f' }),
      ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });
    });

    it('gives a malformed booking id 404 rather than reaching the database', async () => {
      expect(await resolveReviewEligibility('00000000-0000-4000-8000-000000000000', 'not-a-uuid')).toBeNull();
    });
  });
});
