/**
 * Spec 038 §3.8 (AC-9) — the resolver that lifts spec 027's `moderation_evidence` context out of
 * `422 FILE_CONTEXT_NOT_AVAILABLE`. Lives here, not in `lib/files/contexts/`, for the reason
 * `lib/safety/evidence-policy.ts` gives: who may see moderation evidence is a SPEC 038 rule.
 *
 *   UPLOAD — an admin holding the `moderation/<action>` permission of that action's type, while the
 *   action is `pending_approval` (so the approver sees it) or `active`.
 *
 *   READ — an admin holding `moderation/read`, AUDITED BEFORE THE BYTES ARE DISCLOSED. There is no
 *   branch that could admit the moderated user or any non-admin.
 *
 * `publicEligible` is false — the only correct answer for this context.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { ModerationActionType } from '@/lib/types/moderation';
import { MAX_MODERATION_EVIDENCE, MODERATION_EVIDENCE_CONTEXT, MODERATION_READ_ACTION, PERMISSION_ACTION_FOR } from './catalogue';
import { auditModeration, MODERATION_EVENT_TYPES } from './audit';
import { hasModerationPermission } from './permissions';

async function loadActionForEvidence(id: string): Promise<{ action_type: ModerationActionType; status: string } | undefined> {
  const [row] = await queryRows<{ action_type: ModerationActionType; status: string }>(
    getDb(),
    sql`SELECT action_type, status FROM moderation_actions WHERE id = ${id}`,
  );
  return row;
}

export const moderationEvidencePolicy: FileContextPolicy = {
  publicEligible: false,
  maxPerContext: MAX_MODERATION_EVIDENCE,
  allowedKinds: ['image', 'document', 'video'],

  async canUpload({ userId, contextId }) {
    if (!contextId || !isUuid(contextId)) return false;
    const action = await loadActionForEvidence(contextId);
    if (!action || (action.status !== 'pending_approval' && action.status !== 'active')) return false;
    return hasModerationPermission(userId, PERMISSION_ACTION_FOR[action.action_type]);
  },

  async canRead({ userId, asset, correlationId }) {
    const contextId = asset.context_id;
    if (!contextId) return false;
    if (!(await loadActionForEvidence(contextId))) return false;
    if (!(await hasModerationPermission(userId, MODERATION_READ_ACTION))) return false;
    await auditModeration({
      actorUserId: userId,
      eventType: MODERATION_EVENT_TYPES.evidenceRead,
      targetType: 'moderation_action',
      targetId: contextId,
      after: { fileAssetId: asset.id },
      correlationId: correlationId ?? null,
    });
    return true;
  },
};

/** Called from `registerModerationIntegration()`; never from `lib/files`. */
export function registerModerationEvidenceContext(): void {
  registerFileContextPolicy(MODERATION_EVIDENCE_CONTEXT, moderationEvidencePolicy);
}
