/**
 * Spec 027 §4 — the `file_assets` row as this spec sees it, and the DTO projection.
 *
 * The row carries routing and diagnostic data the client never gets: `storage_key`,
 * `checksum_sha256`, the scan columns, the idempotency columns and the owner id all stop here
 * (§4 "Retention and privacy"). `toFileAssetDto` is the ONLY projection any route returns.
 *
 * `context_type` is nullable at the database because spec 008 has always inserted a bare row for an
 * export artifact and must keep working untouched (AC-10). Such a row is not a spec 027 asset: it
 * has no context policy, so `loadOwnedAsset`/`loadReadableAsset` refuse it and it never reaches the
 * DTO. Spec 008's own signed download route remains the only path to an export.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { FileAssetDto, FileContextType, FileKind, FileStatus, FileVisibility, ScanOutcome } from '@/lib/types/files';
import { isFileContextType } from '@/lib/types/files';
import { fileNotFoundError } from './errors';
import { queryRows, type Executor } from './sql';

export interface FileAssetRow {
  id: string;
  uploaded_by_user_id: string | null;
  kind: FileKind;
  visibility: FileVisibility;
  status: FileStatus;
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  file_name: string | null;
  checksum_sha256: string | null;
  context_type: FileContextType | null;
  context_id: string | null;
  scan_outcome: ScanOutcome | null;
  scan_attempts: number;
  scan_next_attempt_at: Date | null;
  rejection_reason: string | null;
  ready_at: Date | string | null;
  deleted_at: Date | null;
  storage_deleted_at: Date | null;
  legal_hold: boolean;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

/** Every column this domain reads. Listed explicitly so a later column cannot leak by `SELECT *`. */
export const FILE_ASSET_COLUMNS = sql`
  id, uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes, file_name,
  checksum_sha256, context_type, context_id, scan_outcome, scan_attempts, scan_next_attempt_at,
  rejection_reason, ready_at, deleted_at, storage_deleted_at, legal_hold, idempotency_key,
  idempotency_fingerprint, created_at, updated_at, version
`;

export function toFileAssetDto(row: FileAssetRow): FileAssetDto {
  if (!isFileContextType(row.context_type)) {
    // Unreachable through any route: every load path refuses a context-less row first. Treated as
    // "not found" rather than coerced to a context it does not have.
    throw fileNotFoundError();
  }
  return {
    id: row.id,
    kind: row.kind,
    visibility: row.visibility,
    status: row.status,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    fileName: row.file_name,
    contextType: row.context_type,
    contextId: row.context_id,
    rejectionReason: row.status === 'rejected' ? row.rejection_reason : null,
    // `db.execute` hands raw driver values back, so timestamps arrive as strings on some paths and
    // Dates on others — normalised here the same way spec 026's `toNotificationDto` does.
    createdAt: new Date(row.created_at).toISOString(),
    readyAt: row.ready_at === null ? null : new Date(row.ready_at).toISOString(),
    version: row.version,
  };
}

/**
 * Loads a live asset by id, or `null`. A soft-deleted row (AC-9) reads as absent to EVERYONE
 * including its owner, and a context-less row (spec 008's export artifact) is likewise invisible
 * here — so `data_export` can never be reached through this spec's routes.
 */
export async function findLiveAsset(id: string, db: Executor = getDb()): Promise<FileAssetRow | null> {
  const [row] = await queryRows<FileAssetRow>(
    db,
    sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets
         WHERE id = ${id} AND deleted_at IS NULL AND context_type IS NOT NULL AND context_type <> 'data_export'`,
  );
  return row ?? null;
}

/** Counts a context's live, non-rejected assets — the cap `upload-url` enforces (§3 "Limits"). */
export async function countContextAssets(
  db: Executor,
  contextType: FileContextType,
  contextId: string | null,
): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM file_assets
         WHERE context_type = ${contextType}
           AND context_id IS NOT DISTINCT FROM ${contextId}
           AND deleted_at IS NULL
           AND status <> 'rejected'`,
  );
  return row?.n ?? 0;
}

/**
 * §4 "Observability" — the structured log shape every file event shares. Deliberately carries no
 * file name, storage key, signature or byte content (master §117); `boundaries.test.ts` asserts it.
 */
export function logFileEvent(
  event: string,
  fields: {
    correlationId?: string | null;
    fileAssetId?: string | null;
    contextType?: string | null;
    kind?: string | null;
    status?: string | null;
    [extra: string]: unknown;
  },
): void {
  console.log(JSON.stringify({ event, ...fields }));
}
