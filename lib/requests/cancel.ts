import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { requests, requestsStatusHistory } from '@/lib/db/schema';
import type { CancelPreviewDto, RequestDto } from '@/lib/types/requests';
import { isCancellable } from '@/lib/types/requests';
import { previewCancellation } from './cancellation-consequence';
import { notifyProvidersOfCancellation } from './cancellation-notification';
import { requestNotCancellableError, requestVersionConflictError } from './errors';
import { getOwnedRequestRow, getRequestForOwner, toRequestDto } from './read';

/**
 * §3 `GET /api/v1/requests/{id}/cancel-preview` — the read-only dry run master spec §38 requires
 * before the destructive action. Never mutates; ownership-checked exactly like the read path.
 */
export async function previewCancelRequest(userId: string, requestId: string): Promise<CancelPreviewDto> {
  const row = await getOwnedRequestRow(userId, requestId);
  return previewCancellation(row.status);
}

/**
 * §3 `POST /api/v1/requests/{id}/cancel` — AC-4/AC-7.
 *
 * Three layers reject an invalid cancellation, in this order:
 *   1. ownership (`404 REQUEST_NOT_FOUND`, indistinguishable from not-found),
 *   2. this spec's cancellable-state rule (`422 REQUEST_NOT_CANCELLABLE`),
 *   3. optimistic concurrency + the `requests_status_transition_trg` DB trigger — the independent
 *      server-side enforcement master spec §132.18 demands, which holds even if application code
 *      were bypassed entirely.
 */
export async function cancelRequest(userId: string, requestId: string, expectedVersion: unknown): Promise<RequestDto> {
  const row = await getOwnedRequestRow(userId, requestId);

  if (!isCancellable(row.status)) throw requestNotCancellableError(row.status);

  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
    throw requestVersionConflictError();
  }
  if (expectedVersion !== row.version) throw requestVersionConflictError();

  await getDb().transaction(async (tx) => {
    // The `version` predicate makes a concurrent second cancel (or any other concurrent write)
    // lose the race and surface as CONFLICT rather than double-recording the transition.
    const updated = await tx
      .update(requests)
      .set({ status: 'cancelled', version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.version, row.version), eq(requests.status, row.status)))
      .returning({ id: requests.id });
    if (updated.length === 0) throw requestVersionConflictError();

    await tx
      .insert(requestsStatusHistory)
      .values({ requestId, fromStatus: row.status, toStatus: 'cancelled', actorUserId: userId });
  });

  // Master spec §38 "notify affected providers" — the hook; delivery is spec 017/026 (§3).
  await notifyProvidersOfCancellation(requestId);

  return toRequestDto(requestId);
}

export { getRequestForOwner };
