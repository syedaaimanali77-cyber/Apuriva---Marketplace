/**
 * Spec 038 §3.16 (AC-8) — the real `SafetyRestrictionGate` for spec 030's port.
 *
 * Spec 038 owns the restriction; spec 030 stays only the caller. This runs the SAME M1 service a
 * restriction from the admin UI does — no second restriction workflow — with the report as origin:
 *
 *   1. the requesting admin must hold `moderation/restrict` (403 otherwise; spec 030 leaves the
 *      report open because the gate throws before its update);
 *   2. an existing restriction for this report is returned as-is — the partial unique index
 *      `moderation_actions_origin_safety_restriction_uq` makes a retried resolve idempotent;
 *   3. otherwise an account-scope `restriction` is initiated with `origin_safety_report_id` set.
 *
 * No FK is added to `safety_reports.restriction_moderation_action_id` (OQ-4): integrity is held on
 * this side by the origin FK and the unique index. Spec 030's code and schema are untouched.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { RestrictionRequest, RestrictionResult, SafetyRestrictionGate } from '@/lib/safety/restriction-gate';
import { initiateModerationAction } from './actions';
import { requireModerationPermission } from './permissions';

async function existingRestrictionFor(safetyReportId: string): Promise<string | null> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM moderation_actions WHERE origin_safety_report_id = ${safetyReportId} AND action_type = 'restriction'`,
  );
  return row?.id ?? null;
}

export const restrictFromSafetyReport: SafetyRestrictionGate = async (request: RestrictionRequest): Promise<RestrictionResult> => {
  await requireModerationPermission(request.requestedByAdminUserId, 'restrict');

  const existing = await existingRestrictionFor(request.safetyReportId);
  if (existing) return { moderationActionId: existing };

  try {
    const { action } = await initiateModerationAction({
      adminUserId: request.requestedByAdminUserId,
      idempotencyKey: null,
      correlationId: request.correlationId,
      originSafetyReportId: request.safetyReportId,
      body: { actionType: 'restriction', scope: 'account', targetUserId: request.targetUserId, reason: request.reason },
    });
    return { moderationActionId: action.id };
  } catch (err) {
    if (isUniqueViolation(err, 'moderation_actions_origin_safety_restriction_uq')) {
      const winner = await existingRestrictionFor(request.safetyReportId);
      if (winner) return { moderationActionId: winner };
    }
    throw err;
  }
};
