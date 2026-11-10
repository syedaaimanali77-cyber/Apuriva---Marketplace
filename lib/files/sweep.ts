/**
 * Spec 027 §3 / §4 "Purge" (AC-4, AC-9) — the file maintenance sweep, run by
 * `GET /api/v1/cron/file-maintenance-sweep` on the same Vercel Cron mechanism and bearer secret as
 * the ten existing scheduled routes. There is no worker service and none is added.
 *
 * Two passes, in order:
 *
 *   1. **Scan pass** — every `scanning` asset whose `scan_next_attempt_at` is due gets one more
 *      attempt, honouring the `2^attempts`-minute backoff. This is where an `unknown` verdict
 *      eventually resolves, and where a `finalize` whose inline attempt failed is picked up.
 *   2. **Purge pass** — bytes are deleted for assets that are soft-deleted past the grace period,
 *      `rejected`, or `pending` and never finalized. `storage_deleted_at` records that it happened,
 *      so a purge is never attempted twice and a row always says whether its bytes still exist.
 *
 * Both claim with `FOR UPDATE SKIP LOCKED`, so two overlapping runs divide the work instead of
 * fighting over it, and both are bounded by `SWEEP_BATCH_LIMIT` — the next run is the continuation.
 * A `legal_hold` asset is never purged, whatever its `deleted_at` says.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { FILE_ASSET_COLUMNS, logFileEvent, type FileAssetRow } from './assets';
import { adapterOrThrow } from './adapter';
import { purgeGraceDays, SWEEP_BATCH_LIMIT, uploadUrlTtlSeconds } from './config';
import { runScanForAsset } from './scan';
import { queryRows } from './sql';

export interface FileMaintenanceSweepResult {
  scanned: number;
  becameReady: number;
  becameRejected: number;
  purged: number;
  storageUnavailable: boolean;
}

export async function runFileMaintenanceSweep(): Promise<FileMaintenanceSweepResult> {
  const result: FileMaintenanceSweepResult = {
    scanned: 0,
    becameReady: 0,
    becameRejected: 0,
    purged: 0,
    storageUnavailable: false,
  };

  try {
    // Fails fast and loudly if no real adapter is configured (AC-11), rather than sweeping nothing
    // and reporting success.
    adapterOrThrow();
  } catch {
    result.storageUnavailable = true;
    return result;
  }

  for (const asset of await claimDueScans()) {
    result.scanned += 1;
    const updated = await runScanForAsset(asset, null).catch(() => null);
    if (updated?.status === 'ready') result.becameReady += 1;
    if (updated?.status === 'rejected') result.becameRejected += 1;
  }

  result.purged = await purgeDueBytes();
  return result;
}

/** `file_assets_scan_due_idx` on `(status, scan_next_attempt_at)` is what makes this claim cheap. */
async function claimDueScans(): Promise<FileAssetRow[]> {
  return getDb().transaction(async (tx) =>
    queryRows<FileAssetRow>(
      tx,
      sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets
           WHERE status = 'scanning'
             AND deleted_at IS NULL
             AND scan_next_attempt_at IS NOT NULL
             AND scan_next_attempt_at <= clock_timestamp()
           ORDER BY scan_next_attempt_at ASC, id ASC
           LIMIT ${SWEEP_BATCH_LIMIT}
             FOR UPDATE SKIP LOCKED`,
    ),
  );
}

/**
 * The three purge-eligible populations, in one claim. `storage_deleted_at IS NULL` is the guard
 * that makes the whole pass idempotent — and `file_assets_purge_idx` is the partial index on it.
 */
async function purgeDueBytes(): Promise<number> {
  const graceDays = purgeGraceDays();
  // A reservation nobody ever uploaded to: twice the upload-URL TTL, so a slow client is never
  // swept out from under a genuine in-flight upload.
  const abandonedSeconds = uploadUrlTtlSeconds() * 2;

  const due = await getDb().transaction(async (tx) =>
    queryRows<FileAssetRow>(
      tx,
      sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets
           WHERE storage_deleted_at IS NULL
             AND storage_key IS NOT NULL
             AND legal_hold = false
             AND (
               (deleted_at IS NOT NULL AND deleted_at < clock_timestamp() - make_interval(days => ${graceDays}))
               OR status = 'rejected'
               OR (status = 'pending' AND created_at < clock_timestamp() - make_interval(secs => ${abandonedSeconds}))
             )
           ORDER BY created_at ASC, id ASC
           LIMIT ${SWEEP_BATCH_LIMIT}
             FOR UPDATE SKIP LOCKED`,
    ),
  );
  if (due.length === 0) return 0;

  const adapter = adapterOrThrow();
  let purged = 0;
  for (const asset of due) {
    try {
      await adapter.delete(asset.storage_key!);
    } catch {
      // Leave `storage_deleted_at` null so the next run tries again: claiming a purge that did not
      // happen would lose track of bytes that still exist.
      continue;
    }
    await getDb().execute(sql`
      UPDATE file_assets
         SET storage_deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${asset.id} AND storage_deleted_at IS NULL
    `);
    purged += 1;
    logFileEvent('file.purged', {
      fileAssetId: asset.id,
      contextType: asset.context_type,
      kind: asset.kind,
      status: asset.status,
    });
  }
  return purged;
}
