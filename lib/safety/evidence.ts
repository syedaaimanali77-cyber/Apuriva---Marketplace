/**
 * Spec 030 §3 "Evidence" (AC-3) — reads of a report's attachments, and the `legal_hold` stamp that
 * makes retention work without a new mechanism (DECIDED-5).
 *
 * `file_assets.legal_hold` ALREADY EXISTS and spec 027's purge sweep already honours it —
 * `lib/files/deletion.ts` states it outright: "`legal_hold` assets are the exception: they are
 * evidence a later spec must keep". This spec is that later spec. Stamping the flag is therefore
 * the whole of retention here: no second storage system, no second sweep, no new column.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { FILE_ASSET_COLUMNS, toFileAssetDto, type FileAssetRow } from '@/lib/files/assets';
import type { FileAssetDto } from '@/lib/types/files';
import { SAFETY_EVIDENCE_CONTEXT } from './limits';

/**
 * Every `ready`, live evidence asset attached to a report, oldest first.
 *
 * Soft-deleted rows are excluded, and a `scanning` or `rejected` asset never appears: only `ready`
 * bytes are evidence anyone should be shown.
 */
export async function listEvidenceFor(reportId: string): Promise<FileAssetDto[]> {
  const rows = await queryRows<FileAssetRow>(
    getDb(),
    sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets
         WHERE context_type = ${SAFETY_EVIDENCE_CONTEXT}
           AND context_id = ${reportId}
           AND status = 'ready'
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
  );
  return rows.map(toFileAssetDto);
}

/**
 * Places every live evidence asset for a report under legal hold (DECIDED-5).
 *
 * Called when evidence is attached. Idempotent, and deliberately a plain `UPDATE` rather than part
 * of any transition: holding evidence must never depend on a report reaching a particular status,
 * because the whole point is that it survives whatever happens to the account that filed it.
 */
export async function holdEvidenceFor(reportId: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE file_assets
           SET legal_hold = true, updated_at = clock_timestamp()
         WHERE context_type = ${SAFETY_EVIDENCE_CONTEXT}
           AND context_id = ${reportId}
           AND legal_hold = false`,
  );
}
