/**
 * Spec 029 §6 fixtures.
 *
 * Every scenario is built through the REAL path: a booking seeded through specs 015→018→020→021 via
 * `seedConfirmedBooking`, driven to `in_progress` through spec 020's own provider routes and
 * completed through spec 020's own completion function, and media uploaded through spec 027's
 * actual `createUploadTarget`/`finalizeUpload` against the real local storage adapter. Nothing here
 * fakes a `bookings_status_history` row and nothing fakes a `file_assets` row — a faked row would
 * not prove that the upload policy is what stops a foreign asset from existing in the first place.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { completeBooking } from '@/lib/bookings/complete';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { resolveFileStorageAdapter } from '@/lib/files/storage';
import { createUploadTarget, finalizeUpload } from '@/lib/files/upload';
import { jpegBytes, loadAsset, useTemporaryStorageDir } from '@/lib/files/files-test-support';
import { resetProviderRatingSource } from '@/lib/matching/rating-source';
import type { FileContextType, UploadUrlRequest } from '@/lib/types/files';
import { registerReviewsIntegration } from './index';

export { useTemporaryStorageDir };
export {
  seedConfirmedBooking,
  useMessagingIntegration,
  resetMessagingIntegration,
  registerAdmin,
  grantRole,
  type BookingScenario,
} from '@/lib/messaging/messaging-test-support';
export { driveToInProgress, isDatabaseReachable, seedStranger } from '@/lib/bookings/bookings-test-support';
export { seedPermission, registerAdminWithPermission, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';

/**
 * Puts the process in the state `instrumentation.ts` produces for this spec: spec 027's shipped
 * policies, then spec 029's `review_media` context and its spec 017 rating source.
 */
export function useReviewsIntegration(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerReviewsIntegration();
  resetRateLimitState();
}

/** Returns both ports to their documented pre-029 defaults, so no suite leaks into another. */
export function resetReviewsIntegrationForTests(): void {
  resetProviderRatingSource();
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

/**
 * Drives a confirmed booking all the way to `completed` through spec 020's own path, so the
 * `in_progress -> completed` history row eligibility depends on is genuine.
 */
export async function completeBookingForReview(
  scenario: { provider: { userId: string; providerProfileId: string } },
  bookingId: string,
): Promise<void> {
  const { driveToInProgress } = await import('@/lib/bookings/bookings-test-support');
  await driveToInProgress(scenario as never, bookingId);
  await completeBooking(scenario.provider.userId, bookingId, 'provider');
  resetRateLimitState();
}

/**
 * Moves the booking's `completed` history instant backwards, so the review window can be crossed
 * without waiting 14 days.
 *
 * `bookings_status_history` is append-only (`bookings_status_history_append_only_trg`) — the point
 * of spec 020's safeguard S6 — so this DELETEs nothing and disables the trigger for the length of
 * one transaction instead, exactly as `shiftInProgressSince` does. That is a privilege no
 * application path has, and it cannot leak: the surrounding transaction re-enables it before
 * committing.
 */
export async function shiftCompletedSince(bookingId: string, daysAgo: number): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE bookings_status_history DISABLE TRIGGER bookings_status_history_append_only_trg`);
    await tx.execute(sql`
      UPDATE bookings_status_history
         SET occurred_at = clock_timestamp() - (${daysAgo} * interval '1 day')
       WHERE booking_id = ${bookingId} AND to_status = 'completed'
    `);
    await tx.execute(sql`ALTER TABLE bookings_status_history ENABLE TRIGGER bookings_status_history_append_only_trg`);
  });
}

/**
 * Pulls a booking's `scheduled_at` back to now, so spec 020's early-start grace (safeguard S4) does
 * not refuse to advance it.
 *
 * Needed only by the aggregate fixtures, which give several bookings of ONE provider distinct slots
 * days apart so spec 016's overlap check accepts them — and those slots are then far outside the
 * 60-minute grace. The slot-overlap check runs at CREATION only, so moving the time afterwards
 * conflicts with nothing.
 *
 * `bookings_terms_immutable_trg` (spec 020 safeguard: agreed terms never change after the fact) is
 * disabled for the length of ONE transaction, exactly as `shiftInProgressSince` does for the
 * append-only history trigger. That is a fixture-only privilege no application path has, and it
 * cannot leak: the surrounding transaction re-enables it before committing.
 */
export async function shiftScheduledAtToNow(bookingId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE bookings DISABLE TRIGGER bookings_terms_immutable_trg`);
    await tx.execute(sql`UPDATE bookings SET scheduled_at = clock_timestamp() WHERE id = ${bookingId}`);
    await tx.execute(sql`ALTER TABLE bookings ENABLE TRIGGER bookings_terms_immutable_trg`);
  });
}

/**
 * Uploads and finalizes one review photo through spec 027's real path, as the given user in the
 * given mode, against the given context.
 *
 * Deliberately parameterized on user/mode/context so a suite can attempt an UNAUTHORIZED upload and
 * observe spec 027 refusing it, rather than only exercising the happy path.
 */
export async function uploadReviewMedia(
  userId: string,
  activeMode: 'customer' | 'provider',
  bookingId: string,
  options?: { contextType?: FileContextType; finalize?: boolean },
): Promise<string> {
  const request: UploadUrlRequest = {
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 64,
    fileName: 'review.jpg',
    contextType: options?.contextType ?? 'review_media',
    contextId: bookingId,
    visibility: 'public',
  };
  const target = await createUploadTarget({
    session: { userId, activeMode },
    request,
    idempotencyKey: randomUUID(),
    idempotencyFingerprint: idempotencyFingerprint(request),
    correlationId: 'test',
  });

  if (options?.finalize === false) return target.fileAsset.id;

  const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
  await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
  await finalizeUpload({ userId }, target.fileAsset.id, 'test');
  return target.fileAsset.id;
}

export async function reviewRowById(reviewId: string) {
  const [row] = await queryRows<{
    id: string;
    status: string;
    rating: number;
    text: string | null;
    flag_signals: unknown;
    removal_reason: string | null;
    moderated_by_admin_id: string | null;
    moderated_at: Date | null;
    provider_profile_id: string;
    service_id: string;
    author_user_id: string;
  }>(
    getDb(),
    sql`SELECT id, status, rating, text, flag_signals, removal_reason, moderated_by_admin_id,
               moderated_at, provider_profile_id, service_id, author_user_id
          FROM reviews WHERE id = ${reviewId}`,
  );
  return row;
}

export async function countReviews(bookingId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM reviews WHERE booking_id = ${bookingId}`,
  );
  return row!.n;
}

export async function reportRowsFor(reviewId: string) {
  return queryRows<{ id: string; status: string; reason: string; resolved_by_admin_id: string | null }>(
    getDb(),
    sql`SELECT id, status, reason, resolved_by_admin_id FROM review_reports WHERE review_id = ${reviewId}`,
  );
}

export function freshKey(): string {
  return randomUUID();
}

export const BASE = 'http://localhost/api/v1';
