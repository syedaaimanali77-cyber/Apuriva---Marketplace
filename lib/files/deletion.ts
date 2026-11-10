/**
 * Spec 027 §4 (AC-9) — owner deletion, and what deletion is allowed to mean here.
 *
 * A delete is a SOFT delete. The row is never removed: every FK onto `file_assets` is `RESTRICT`
 * and the linkage rows (`request_attachments`, `message_attachments`) are another party's record of
 * a conversation that happened. What deletion does is:
 *
 *   - stamp `deleted_at`, so the asset immediately reads as `404` to everyone including its owner;
 *   - leave every linkage row untouched;
 *   - queue the BYTES for purge, which the maintenance sweep performs after
 *     `FILE_PURGE_GRACE_DAYS` — unless the asset is under `legal_hold`, which is retained as
 *     evidence with its filename redacted.
 *
 * Idempotent: deleting an already-deleted asset is `204`, not an error.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { SessionRow } from '@/lib/auth/session';
import { findLiveAsset, logFileEvent } from './assets';
import { fileNotFoundError } from './errors';
import { queryRows, isUuid } from './sql';

export async function deleteFileAsset(
  session: Pick<SessionRow, 'userId'>,
  fileAssetId: string,
  correlationId: string,
): Promise<void> {
  if (!isUuid(fileAssetId)) throw fileNotFoundError();

  const asset = await findLiveAsset(fileAssetId);
  if (!asset) {
    // Already soft-deleted, never existed, or someone else's: indistinguishable (AC-6). A repeat
    // delete by the owner is therefore `404`, not `204` — the asset genuinely is not there any more.
    throw fileNotFoundError();
  }
  if (asset.uploaded_by_user_id !== session.userId) throw fileNotFoundError();

  await getDb().execute(sql`
    UPDATE file_assets
       SET deleted_at = clock_timestamp(), scan_next_attempt_at = NULL,
           updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${fileAssetId} AND deleted_at IS NULL
  `);

  logFileEvent('file.deleted', {
    correlationId,
    fileAssetId,
    contextType: asset.context_type,
    kind: asset.kind,
    status: asset.status,
  });
}

/**
 * Spec 008's account-deletion sweep hook (§4 "Deletion"). Called from `sweepDeletions()` — the same
 * place spec 026 hooked, so `app/api/v1/cron/account-deletion-sweep/route.ts` stays untouched.
 *
 * A closed account's assets are soft-deleted, their file names redacted to spec 008's sentinel and
 * their bytes queued for purge. `legal_hold` assets are the exception: they are evidence a later
 * spec marked, so they are RETAINED — with the owner already anonymized and the file name redacted
 * just the same. No row is ever hard-deleted.
 */
export async function redactFileAssetsForDeletedUser(
  db: Pick<ReturnType<typeof getDb>, 'execute'>,
  userId: string,
  sentinel: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE file_assets
       SET file_name = ${sentinel},
           deleted_at = CASE WHEN legal_hold THEN deleted_at ELSE COALESCE(deleted_at, clock_timestamp()) END,
           scan_next_attempt_at = CASE WHEN legal_hold THEN scan_next_attempt_at ELSE NULL END,
           updated_at = clock_timestamp(), version = version + 1
     WHERE uploaded_by_user_id = ${userId} AND file_name IS DISTINCT FROM ${sentinel}
  `);
}

/** Test/diagnostic read of the purge bookkeeping — never exported to a client. */
export async function purgeStateOf(fileAssetId: string): Promise<{ deletedAt: Date | null; storageDeletedAt: Date | null } | null> {
  const [row] = await queryRows<{ deleted_at: Date | null; storage_deleted_at: Date | null }>(
    getDb(),
    sql`SELECT deleted_at, storage_deleted_at FROM file_assets WHERE id = ${fileAssetId}`,
  );
  return row ? { deletedAt: row.deleted_at, storageDeletedAt: row.storage_deleted_at } : null;
}
