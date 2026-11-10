/**
 * Spec 027 §3 "Scanning" (AC-4) — applying a scanner verdict to an asset.
 *
 * The one rule everything else follows from: **nothing becomes `ready` without a `clean` verdict
 * from the configured scanner.** `unknown`, a scanner that throws and a scanner that cannot be
 * resolved at all all leave the asset non-`ready` and retryable — never `ready` on a guess, so a
 * file with an unresolved scan is readable by nobody, including its owner's counterparty.
 *
 * Migration 0023's `file_assets_ready_requires_clean_ck` enforces the same rule at the database, so
 * a future code path that forgot it would fail the write rather than expose an unscanned file.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { FILE_ASSET_COLUMNS, logFileEvent, type FileAssetRow } from './assets';
import { decideAfterScan } from './lifecycle';
import { resolveFileScanner } from './scanning';
import { adapterOrThrow } from './adapter';
import { queryRows } from './sql';

/**
 * Runs one scan attempt and writes its consequence. Returns the updated row, or `null` when the
 * asset was concurrently moved by another worker (the sweep claims `FOR UPDATE SKIP LOCKED`, so
 * that is an ordinary outcome, not an error).
 */
export async function runScanForAsset(asset: FileAssetRow, correlationId: string | null): Promise<FileAssetRow | null> {
  if (asset.status !== 'scanning' || asset.storage_key === null) return null;

  const attempts = asset.scan_attempts + 1;

  let outcome: 'clean' | 'rejected' | 'unknown';
  let reasonCode: string | undefined;
  try {
    const scanner = resolveFileScanner();
    const result = await scanner.scan({
      fileAssetId: asset.id,
      storageKey: asset.storage_key,
      mimeType: asset.mime_type ?? 'application/octet-stream',
      sizeBytes: Number(asset.size_bytes ?? 0),
    });
    outcome = result.outcome;
    reasonCode = result.reasonCode;
  } catch {
    // A scanner that is unavailable, misconfigured or failing is NOT a clean bill of health.
    outcome = 'unknown';
  }

  const decision = decideAfterScan(outcome, attempts, reasonCode);
  const db = getDb();

  if (decision.status === 'ready') {
    const [row] = await queryRows<FileAssetRow>(
      db,
      sql`UPDATE file_assets
             SET status = 'ready', ready_at = clock_timestamp(), scan_outcome = 'clean',
                 scan_attempts = ${attempts}, scan_next_attempt_at = NULL,
                 updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${asset.id} AND status = 'scanning' AND deleted_at IS NULL
           RETURNING ${FILE_ASSET_COLUMNS}`,
    );
    logScan(correlationId, asset, 'clean', 'ready');
    return row ?? null;
  }

  if (decision.status === 'rejected') {
    // AC-4: bytes are purged IMMEDIATELY — a rejected object is never left in storage.
    await adapterOrThrow()
      .delete(asset.storage_key)
      .catch(() => undefined);
    const [row] = await queryRows<FileAssetRow>(
      db,
      sql`UPDATE file_assets
             SET status = 'rejected', scan_outcome = 'rejected', rejection_reason = ${decision.reasonCode},
                 scan_attempts = ${attempts}, scan_next_attempt_at = NULL,
                 storage_deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${asset.id} AND status = 'scanning' AND deleted_at IS NULL
           RETURNING ${FILE_ASSET_COLUMNS}`,
    );
    logScan(correlationId, asset, 'rejected', 'rejected', { reasonCode: decision.reasonCode });
    return row ?? null;
  }

  // `unknown`: the asset stays `scanning`. `scan_next_attempt_at = NULL` at the ceiling is what
  // takes it out of the sweep's claim path without ever giving it a terminal state.
  const exhausted = 'exhausted' in decision;
  const [row] = await queryRows<FileAssetRow>(
    db,
    sql`UPDATE file_assets
           SET scan_outcome = 'unknown', scan_attempts = ${attempts},
               scan_next_attempt_at = ${
                 decision.retryInMinutes === null
                   ? sql`NULL`
                   : sql`clock_timestamp() + make_interval(mins => ${decision.retryInMinutes})`
               },
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${asset.id} AND status = 'scanning' AND deleted_at IS NULL
         RETURNING ${FILE_ASSET_COLUMNS}`,
  );

  if (exhausted) {
    // An operator's signal, not a state change: someone must look at this file.
    logFileEvent('file.scan_unresolved', {
      correlationId,
      fileAssetId: asset.id,
      contextType: asset.context_type,
      kind: asset.kind,
      status: 'scanning',
      attempts,
    });
  } else {
    logScan(correlationId, asset, 'unknown', 'scanning', { attempts });
  }
  return row ?? null;
}

function logScan(
  correlationId: string | null,
  asset: FileAssetRow,
  outcome: string,
  status: string,
  extra: Record<string, unknown> = {},
): void {
  logFileEvent('file.scan_completed', {
    correlationId,
    fileAssetId: asset.id,
    contextType: asset.context_type,
    kind: asset.kind,
    status,
    outcome,
    ...extra,
  });
}
