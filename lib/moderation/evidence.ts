/**
 * Spec 038 §3.8 — reads of an action's evidence, and the `legal_hold` stamp.
 *
 * Spec 027 owns every byte; this reads `file_assets` rows in the `moderation_evidence` context whose
 * `context_id` is the action id. `legal_hold` (spec 031's `holdEvidenceFor()` precedent) keeps the
 * evidence through spec 008's deletion redaction. There is no "attach" route: evidence is uploaded
 * straight into the context, so the stamp is applied whenever this spec touches the action —
 * its detail read, its execution, its reversal and its appeal decision.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { MODERATION_EVIDENCE_CONTEXT } from './catalogue';

/** Every `ready`, live evidence asset id for an action, oldest first. */
export async function listEvidenceIds(moderationActionId: string): Promise<string[]> {
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM file_assets
         WHERE context_type = ${MODERATION_EVIDENCE_CONTEXT} AND context_id = ${moderationActionId}
           AND status = 'ready' AND deleted_at IS NULL
         ORDER BY created_at ASC`,
  );
  return rows.map((r) => r.id);
}

/** Idempotent. Never part of a transition: holding evidence must not depend on an action's status. */
export async function holdModerationEvidence(moderationActionId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE file_assets SET legal_hold = true, updated_at = clock_timestamp()
     WHERE context_type = ${MODERATION_EVIDENCE_CONTEXT} AND context_id = ${moderationActionId} AND legal_hold = false`);
}
