/**
 * Spec 027 §4 "Retention and privacy" — this spec's contribution to spec 008's export.
 *
 * METADATA ONLY, and only the caller's OWN assets. Bytes are deliberately not exported: they are
 * already reachable through their own authorized, expiring URLs, and copying them into an export
 * artifact would create a second, unexpiring copy of exactly the material this spec exists to keep
 * behind authorization.
 *
 * NEVER exported, at any size: `storage_key`, `checksum_sha256`, `scan_outcome`, `scan_attempts`,
 * `scan_next_attempt_at`, `idempotency_key`, `idempotency_fingerprint`, `legal_hold`,
 * `storage_deleted_at` — server-side routing and diagnostics, not the user's record — and never
 * another party's asset.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { FileContextType, FileKind, FileStatus } from '@/lib/types/files';
import { queryRows } from './sql';

export interface ExportedFileAsset {
  id: string;
  kind: FileKind;
  mimeType: string | null;
  sizeBytes: number | null;
  fileName: string | null;
  /** Null for spec 008's own export-artifact rows, which predate this spec's context vocabulary. */
  contextType: FileContextType | null;
  status: FileStatus;
  createdAt: string;
}

export async function exportFileAssetData(userId: string): Promise<ExportedFileAsset[]> {
  const rows = await queryRows<{
    id: string;
    kind: FileKind;
    mime_type: string | null;
    size_bytes: number | null;
    file_name: string | null;
    context_type: FileContextType | null;
    status: FileStatus;
    created_at: Date;
  }>(
    getDb(),
    sql`SELECT id, kind, mime_type, size_bytes, file_name, context_type, status, created_at
          FROM file_assets
         WHERE uploaded_by_user_id = ${userId} AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    fileName: row.file_name,
    contextType: row.context_type,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
