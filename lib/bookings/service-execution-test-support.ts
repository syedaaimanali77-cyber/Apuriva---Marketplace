/**
 * Spec 028 §6 fixtures.
 *
 * Every scenario is built through the REAL path: a booking seeded through specs 015→018→020→021 via
 * `seedConfirmedBooking`, driven to `in_progress` through spec 020's own provider routes, and
 * evidence uploaded through spec 027's actual `createUploadTarget`/`finalizeUpload` with the real
 * local storage adapter. Nothing here fakes a `file_assets` row, because a faked row would not
 * prove that the upload policy is what prevents a foreign asset from existing in the first place.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { resolveFileStorageAdapter } from '@/lib/files/storage';
import { createUploadTarget, finalizeUpload } from '@/lib/files/upload';
import { jpegBytes, loadAsset, useTemporaryStorageDir } from '@/lib/files/files-test-support';
import type { FileContextType, UploadUrlRequest } from '@/lib/types/files';
import { resetCompletionEvidenceGate } from './completion-evidence';
import { registerServiceExecutionIntegration } from './service-execution';

export { useTemporaryStorageDir };
export {
  seedConfirmedBooking,
  useMessagingIntegration,
  resetMessagingIntegration,
} from '@/lib/messaging/messaging-test-support';
export { driveToInProgress, isDatabaseReachable } from './bookings-test-support';
import { shiftInProgressSince } from './bookings-test-support';

/**
 * Clears spec 020's `MIN_IN_PROGRESS_SECONDS` dwell without sleeping, for a suite that drives the
 * lifecycle itself rather than through `driveToInProgress` (which already does this).
 */
export async function shiftDwell(bookingId: string, secondsAgo = 120): Promise<void> {
  await shiftInProgressSince(bookingId, secondsAgo);
}

/**
 * Puts the process in the state `instrumentation.ts` produces: spec 027's shipped policies plus
 * spec 028's gate and `booking_evidence` context.
 */
export function useServiceExecutionIntegration(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerServiceExecutionIntegration();
  resetRateLimitState();
}

/** Returns both ports to their documented pre-028 defaults, so no suite leaks into another. */
export function resetServiceExecutionIntegration(): void {
  resetCompletionEvidenceGate();
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

/** Flips the catalog requirement for a booking's service — the ONLY place it can come from. */
export async function setCompletionEvidenceRequired(serviceId: string, required: boolean): Promise<void> {
  await getDb().execute(
    sql`UPDATE services SET completion_evidence_required = ${required} WHERE id = ${serviceId}`,
  );
}

/**
 * Uploads and finalizes one evidence file through spec 027's real path, as the given user in the
 * given mode, against the given context. Returns the asset id.
 *
 * Deliberately parameterized on user/mode/context so a suite can attempt an UNAUTHORIZED upload and
 * observe spec 027 refusing it, rather than only exercising the happy path.
 */
export async function uploadEvidence(
  userId: string,
  activeMode: 'customer' | 'provider',
  bookingId: string,
  options?: { contextType?: FileContextType; finalize?: boolean },
): Promise<string> {
  const request: UploadUrlRequest = {
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 64,
    fileName: 'evidence.jpg',
    contextType: options?.contextType ?? 'booking_evidence',
    contextId: bookingId,
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

/** Soft-deletes an asset the way spec 027's own delete does, so the gate must stop counting it. */
export async function softDeleteAsset(fileAssetId: string): Promise<void> {
  await getDb().execute(sql`UPDATE file_assets SET deleted_at = clock_timestamp() WHERE id = ${fileAssetId}`);
}

export async function milestoneRows(bookingId: string) {
  return queryRows<{
    id: string;
    milestone_type: string;
    note: string | null;
    created_by_user_id: string;
    idempotency_key: string;
  }>(
    getDb(),
    sql`SELECT id, milestone_type, note, created_by_user_id, idempotency_key
          FROM booking_milestones WHERE booking_id = ${bookingId} ORDER BY created_at, id`,
  );
}

export async function countMilestones(bookingId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM booking_milestones WHERE booking_id = ${bookingId}`,
  );
  return row!.n;
}

export function freshKey(): string {
  return randomUUID();
}
