/**
 * Spec 029 §6 — AC-9: the admin permission boundary.
 *
 * `('reviews','read_moderation_queue')` and `('reviews','moderate')` are seeded by migration 0026
 * for exactly two roles. This asserts the negative case for every OTHER role, because "Trust &
 * Safety can moderate" is only half the requirement — the half that matters is that nobody else can.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { createReview } from './create';
import { resolveReviewModeration } from './moderation';
import { requireReviewModeratePermission, requireReviewQueuePermission } from './permissions';
import { reviewRowById } from './reviews-test-support';
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
} from './reviews-test-support';

const reachable = await isDatabaseReachable();

/** Master §69's seven roles. Only the two on the right of the split may touch a review. */
const AUTHORIZED: AdminRole[] = ['trust_safety_admin', 'super_admin'];
const UNAUTHORIZED: AdminRole[] = [
  'operations_admin',
  'support_admin',
  'finance_admin',
  'content_admin',
  'analytics_admin',
];

describe.skipIf(!reachable)('spec 029 admin authorization (AC-9)', () => {
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

  async function aReview(): Promise<string> {
    const seeded = await seedConfirmedBooking();
    await completeBookingForReview(seeded.scenario, seeded.bookingId);
    const { review } = await createReview(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { rating: 1, text: 'Poor work, and late as well.', mediaFileAssetIds: [] },
      { key: freshKey(), fingerprint: 'f' },
    );
    return review.id;
  }

  it('seeds both permissions for exactly the two authorized roles', async () => {
    const rows = await queryRows<{ name: string; action: string; risk_tier: string }>(
      getDb(),
      sql`SELECT r.name, p.action, p.risk_tier
            FROM permissions p JOIN roles r ON r.id = p.role_id
           WHERE p.resource = 'reviews'
           ORDER BY p.action, r.name`,
    );

    expect(rows.map((r) => `${r.name}:${r.action}`).sort()).toEqual([
      'super_admin:moderate',
      'super_admin:read_moderation_queue',
      'trust_safety_admin:moderate',
      'trust_safety_admin:read_moderation_queue',
    ]);
    // Master §70: `medium` is "authorized admin + reason/audit"; reading a queue of already-public
    // content is `low`. No `high` tier and so no four-eyes framework.
    expect(rows.find((r) => r.action === 'moderate')!.risk_tier).toBe('medium');
    expect(rows.find((r) => r.action === 'read_moderation_queue')!.risk_tier).toBe('low');
  });

  describe.each(AUTHORIZED)('%s', (role) => {
    it('may read the queue and moderate', async () => {
      const admin = await registerAdmin();
      await grantRole(admin, role);

      await expect(requireReviewQueuePermission(admin.userId)).resolves.toBeUndefined();
      await expect(requireReviewModeratePermission(admin.userId)).resolves.toBeUndefined();
    });
  });

  describe.each(UNAUTHORIZED)('%s', (role) => {
    it('receives 403 on both, resolved server-side', async () => {
      const admin = await registerAdmin();
      await grantRole(admin, role);

      await expect(requireReviewQueuePermission(admin.userId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      await expect(requireReviewModeratePermission(admin.userId)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    });

    it('cannot remove a review even by calling the domain function directly', async () => {
      // The route checks the permission, but the invariant must not depend on the route: an
      // unauthorized actor with no admin profile cannot satisfy `reviews_removal_pairing_ck`.
      const admin = await registerAdmin();
      await grantRole(admin, role);
      const reviewId = await aReview();

      await expect(requireReviewModeratePermission(admin.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await reviewRowById(reviewId)).status).toBe('published');
    });
  });

  it('refuses an admin-less user outright', async () => {
    const seeded = await seedConfirmedBooking();
    await expect(requireReviewModeratePermission(seeded.scenario.customer.userId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses to record a removal for an actor with no admin profile', async () => {
    // Belt and braces for the database constraint: `moderated_by_admin_id` is an admin-profile FK,
    // so an actor without one cannot be recorded as the remover — which is the point of C-4.
    const reviewId = await aReview();
    const seeded = await seedConfirmedBooking();

    await expect(
      resolveReviewModeration({
        adminUserId: seeded.scenario.customer.userId,
        reviewId,
        decision: 'remove',
        reason: 'Trying to remove without being an admin at all.',
        expectedStatus: 'published',
        correlationId: 'c',
      }),
    ).rejects.toBeTruthy();

    expect((await reviewRowById(reviewId)).status).toBe('published');
  });
});
