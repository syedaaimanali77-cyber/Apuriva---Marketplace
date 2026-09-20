/**
 * Spec 031 §3 "Evidence" (AC-3) — linking a spec 027 asset to a dispute, reading the list, and the
 * legal-hold stamp that makes retention work without a new mechanism (DECIDED-6).
 *
 * BYTES NEVER PASS THROUGH THIS MODULE. Spec 027 owns the upload URL, the scanning, the storage,
 * the signed content fetch and the deletion; this file writes one `dispute_evidence` row recording
 * that an already-finalized asset belongs to a dispute, and reads it back. There is no second
 * storage system, no second sweep and no new media route.
 *
 * `file_assets.legal_hold` ALREADY EXISTS and spec 027's purge sweep already honours it —
 * `lib/files/deletion.ts` says so outright: "`legal_hold` assets are the exception: they are
 * evidence a later spec must keep". Stamping the flag is therefore the whole of retention here.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { PageParams } from '@/lib/api/pagination';
import type { DisputeEvidenceDto } from '@/lib/types/disputes';
import {
  disputeEvidenceLimitReachedError,
  disputeEvidenceNotAttachableError,
  disputeNotOpenError,
} from './errors';
import { DISPUTE_EVIDENCE_CONTEXT, MAX_DISPUTE_EVIDENCE } from './limits';
import { requireDisputeReadPermission } from './permissions';
import { auditDispute, DISPUTE_EVENT_TYPES, resolveAdminAccess, resolveParticipantAccess } from './read';
import { isContributable } from './transitions';
import { toEvidenceDto, type EvidenceRow } from './rows';
import type { ParsedEvidenceLink } from './validation';

const EVIDENCE_COLUMNS = 'id, file_asset_id, submitted_by_user_id, created_at';

/** The admin user ids that have submitted evidence on a dispute, so the DTO can label them. */
async function adminSubmitterIds(disputeId: string): Promise<Set<string>> {
  const rows = await queryRows<{ submitted_by_user_id: string }>(
    getDb(),
    sql`SELECT DISTINCT e.submitted_by_user_id
          FROM dispute_evidence e
          JOIN admin_profiles ap ON ap.user_id = e.submitted_by_user_id
         WHERE e.dispute_id = ${disputeId}`,
  );
  return new Set(rows.map((r) => r.submitted_by_user_id));
}

/**
 * AC-3 — links one finalized asset to a dispute.
 *
 * The asset must be the caller's own, `ready`, live, and already carrying this dispute's
 * `dispute_evidence` context — which spec 027's policy (`lib/disputes/evidence-policy.ts`) enforced
 * at upload time. Re-checking it here is not redundant: it is what stops a caller pointing the link
 * at someone else's asset id after the fact.
 */
export async function linkEvidence(
  disputeId: string,
  userId: string,
  input: ParsedEvidenceLink,
  idempotency: { key: string; fingerprint: string },
): Promise<{ evidence: DisputeEvidenceDto; replayed: boolean }> {
  const ownership = await resolveParticipantAccess(disputeId, userId);
  const db = getDb();

  const [replay] = await queryRows<EvidenceRow>(
    db,
    sql`SELECT ${sql.raw(EVIDENCE_COLUMNS)} FROM dispute_evidence
         WHERE dispute_id = ${disputeId} AND file_asset_id = ${input.fileAssetId}`,
  );
  if (replay) {
    return { evidence: toEvidenceDto(replay, userId, await adminSubmitterIds(disputeId)), replayed: true };
  }

  if (!isContributable(ownership.status)) throw disputeNotOpenError(ownership.status);

  const [count] = await queryRows<{ total: number }>(
    db,
    sql`SELECT COUNT(*)::int AS total FROM dispute_evidence WHERE dispute_id = ${disputeId}`,
  );
  if ((count?.total ?? 0) >= MAX_DISPUTE_EVIDENCE) throw disputeEvidenceLimitReachedError(MAX_DISPUTE_EVIDENCE);

  const [asset] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM file_assets
         WHERE id = ${input.fileAssetId}
           AND uploaded_by_user_id = ${userId}
           AND context_type = ${DISPUTE_EVIDENCE_CONTEXT}
           AND context_id = ${disputeId}
           AND status = 'ready'
           AND deleted_at IS NULL`,
  );
  if (!asset) throw disputeEvidenceNotAttachableError(input.fileAssetId);

  let row: EvidenceRow;
  try {
    const [inserted] = await queryRows<EvidenceRow>(
      db,
      sql`INSERT INTO dispute_evidence
            (dispute_id, submitted_by_user_id, file_asset_id, idempotency_key, idempotency_fingerprint)
          VALUES (${disputeId}, ${userId}, ${input.fileAssetId}, ${idempotency.key}, ${idempotency.fingerprint})
          RETURNING ${sql.raw(EVIDENCE_COLUMNS)}`,
    );
    row = inserted!;
  } catch (err) {
    if (isUniqueViolation(err, 'dispute_evidence_dispute_asset_uq')) {
      const [existing] = await queryRows<EvidenceRow>(
        db,
        sql`SELECT ${sql.raw(EVIDENCE_COLUMNS)} FROM dispute_evidence
             WHERE dispute_id = ${disputeId} AND file_asset_id = ${input.fileAssetId}`,
      );
      if (existing) return { evidence: toEvidenceDto(existing, userId, await adminSubmitterIds(disputeId)), replayed: true };
    }
    throw err;
  }

  await holdEvidenceFor(disputeId);
  return { evidence: toEvidenceDto(row, userId, await adminSubmitterIds(disputeId)), replayed: false };
}

async function pageEvidence(disputeId: string, page: PageParams): Promise<{ rows: EvidenceRow[]; total: number }> {
  const db = getDb();
  const rows = await queryRows<EvidenceRow>(
    db,
    sql`SELECT ${sql.raw(EVIDENCE_COLUMNS)} FROM dispute_evidence
         WHERE dispute_id = ${disputeId}
         ORDER BY created_at ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: number }>(
    db,
    sql`SELECT COUNT(*)::int AS total FROM dispute_evidence WHERE dispute_id = ${disputeId}`,
  );
  return { rows, total: count?.total ?? 0 };
}

/** Both participants see BOTH sides' evidence (DECIDED-6). */
export async function listEvidenceForParticipant(
  disputeId: string,
  userId: string,
  page: PageParams,
): Promise<{ items: DisputeEvidenceDto[]; total: number }> {
  await resolveParticipantAccess(disputeId, userId);
  const { rows, total } = await pageEvidence(disputeId, page);
  const admins = await adminSubmitterIds(disputeId);
  return { items: rows.map((row) => toEvidenceDto(row, userId, admins)), total };
}

/** The admin list. Audited; the per-asset BYTE read is audited separately by the context policy. */
export async function listEvidenceForAdmin(
  disputeId: string,
  adminUserId: string,
  page: PageParams,
  correlationId: string | null,
): Promise<{ items: DisputeEvidenceDto[]; total: number }> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeReadPermission);
  const { rows, total } = await pageEvidence(disputeId, page);
  const admins = await adminSubmitterIds(disputeId);

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.evidenceRead,
    targetId: disputeId,
    correlationId,
    details: { returned: rows.length, listing: true },
  });

  return { items: rows.map((row) => toEvidenceDto(row, adminUserId, admins)), total };
}

/**
 * Places every live evidence asset for a dispute under legal hold (DECIDED-6).
 *
 * Called when evidence is linked, and again when an admin sets `legal_hold` explicitly. Idempotent,
 * and deliberately a plain `UPDATE` rather than part of any transition: holding evidence must never
 * depend on a dispute reaching a particular status, because the whole point is that it survives
 * whatever happens to the accounts involved.
 */
export async function holdEvidenceFor(disputeId: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE file_assets
           SET legal_hold = true, updated_at = clock_timestamp()
         WHERE context_type = ${DISPUTE_EVIDENCE_CONTEXT}
           AND context_id = ${disputeId}
           AND legal_hold = false`,
  );
}

/** Descriptors for the advisory AI brief — kind and filename only, never bytes, never a URL. */
export async function evidenceDescriptors(disputeId: string): Promise<string[]> {
  const rows = await queryRows<{ kind: string; file_name: string | null }>(
    getDb(),
    sql`SELECT fa.kind, fa.file_name
          FROM dispute_evidence de
          JOIN file_assets fa ON fa.id = de.file_asset_id
         WHERE de.dispute_id = ${disputeId} AND fa.deleted_at IS NULL
         ORDER BY de.created_at ASC`,
  );
  return rows.map((r) => `${r.kind}${r.file_name ? `: ${r.file_name}` : ''}`);
}
