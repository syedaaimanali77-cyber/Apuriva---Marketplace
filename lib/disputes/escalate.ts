/**
 * Spec 031 §3 "Safety boundary" (DECIDED-9) — the one-way seam into spec 030.
 *
 * SPEC 030 §1 ALREADY STATES THE DIRECTION: "a safety concern arising from a dispute escalates
 * here, not the reverse." This file implements exactly that and nothing more.
 *
 * WHAT IT DOES: calls spec 030's own `createSafetyReport()`, then records the resulting report id
 * on `disputes.escalated_safety_report_id` as a cross-reference.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — and `lib/disputes/no-money-leak.test.ts` plus
 * `lib/disputes/boundary.test.ts` assert the absence at source level:
 *
 *   - no `INSERT INTO safety_reports`: the report is created by spec 030's path, which owns the
 *     self-report check, the target-exists check, the default priority and the AI summary;
 *   - no priority is set: spec 030 performs NO automated classification (its DECIDED-1) and this
 *     spec must not smuggle one in through the back door;
 *   - no restriction, no ban, no `users.lifecycle_status` write, no moderation action — those are
 *     spec 038's and spec 030 does not own them either;
 *   - no reverse direction: spec 030 opens no dispute, and no route here lets it.
 *
 * THE TWO RECORDS THEN PROCEED INDEPENDENTLY. Closing the dispute does not close the safety report,
 * and resolving the safety report does not resolve the dispute. Escalation does NOT pause the
 * dispute either: a safety concern and a money disagreement are answered by different people on
 * different timelines, and making one wait for the other would serve neither.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { validationError } from '@/lib/api/errors';
import { createSafetyReport } from '@/lib/safety';
import { isSafetyCategory } from '@/lib/types/safety';
import { requireSafetyReadPermission } from '@/lib/safety/permissions';
import { disputeParticipantConflictError } from './errors';
import { requireDisputeResolvePermission } from './permissions';
import { auditDispute, DISPUTE_EVENT_TYPES, isDisputeParticipant, resolveAdminAccess } from './read';
import type { ParsedSafetyEscalation } from './validation';

export interface EscalationResult {
  safetyReportId: string;
}

/**
 * DECIDED-9 — files a safety report about a named participant of the dispute's booking.
 *
 * Requires BOTH `disputes/resolve` and spec 030's `safety_reports/read`. Two permissions rather
 * than one because this crosses a boundary: an admin who can decide disputes should not be able to
 * inject records into the Trust & Safety queue unless they also belong to it.
 *
 * `targetUserId` must be a participant of THIS booking. An escalation naming an unrelated person
 * would be a way to file a safety report while attributing it to a dispute they have nothing to do
 * with, which is exactly the kind of laundering this seam must not permit.
 */
export async function escalateToSafety(
  disputeId: string,
  adminUserId: string,
  input: ParsedSafetyEscalation,
  idempotency: { key: string; fingerprint: string },
  correlationId: string | null,
): Promise<EscalationResult> {
  const ownership = await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);
  // Spec 030's own gate, called directly so its role list stays spec 030's to change.
  await requireSafetyReadPermission(adminUserId);

  if (!isDisputeParticipant(ownership, input.targetUserId)) {
    throw validationError([{ field: 'targetUserId', message: 'must be a participant of this dispute' }]);
  }
  // Defence in depth: `resolveAdminAccess` already refused a participating admin, so this can only
  // fire if that rule is ever loosened.
  if (input.targetUserId === adminUserId) throw disputeParticipantConflictError();

  if (!isSafetyCategory(input.category)) {
    throw validationError([{ field: 'category', message: 'is not a valid safety category' }]);
  }

  // Spec 030's creation path — not an INSERT. It owns priority, the AI summary and its own audit.
  const { report } = await createSafetyReport(
    adminUserId,
    {
      targetUserId: input.targetUserId,
      category: input.category,
      description: input.reason,
      bookingId: ownership.bookingId,
    },
    idempotency,
  );

  await getDb().execute(
    sql`UPDATE disputes
           SET escalated_safety_report_id = ${report.id}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${disputeId} AND escalated_safety_report_id IS NULL`,
  );

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.safetyEscalated,
    targetId: disputeId,
    reason: input.reason,
    correlationId,
    details: { safetyReportId: report.id, targetUserId: input.targetUserId },
  });

  return { safetyReportId: report.id };
}
