/**
 * Spec 038 §3.10 (AC-4) — every moderation audit event goes through spec 009's EXISTING
 * `recordAdminAuditEvent()`, which persists to `security_events`. Nothing here assumes spec 039
 * (Draft): no retrieval, retention or `audit_logs` storage. When spec 039 ships it migrates the store
 * behind that helper.
 *
 * An audit failure is NOT swallowed: it propagates, exactly as spec 030's routes behave.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import { queryRows } from '@/lib/offers/db';
import type { ModerationApprovalEntryDto } from '@/lib/types/moderation';

export const MODERATION_EVENT_TYPES = {
  actionApplied: 'moderation.action_applied',
  actionPending: 'moderation.action_pending',
  actionExecuted: 'moderation.action_executed',
  actionRejectedReconciled: 'moderation.action_rejected_reconciled',
  reversalRequested: 'moderation.reversal_requested',
  actionReversed: 'moderation.action_reversed',
  sessionsRevoked: 'moderation.sessions_revoked',
  appealFiled: 'moderation.appeal_filed',
  appealDecided: 'moderation.appeal_decided',
  evidenceRead: 'moderation.evidence_read',
  signalDismissed: 'fraud_signal.dismissed',
  signalEscalated: 'fraud_signal.escalated',
  signalActioned: 'fraud_signal.actioned',
} as const;

export interface ApprovalChain {
  adminActionId: string | null;
  initiatedBy: string | null;
  decidedBy: string | null;
  decision: 'approved' | 'rejected' | null;
  decidedAt: string | null;
}

/** Spec 009's chain for one `AdminAction`, read from `admin_action_approvals`. */
export async function approvalChainFor(adminActionId: string | null): Promise<ApprovalChain> {
  if (!adminActionId) return { adminActionId: null, initiatedBy: null, decidedBy: null, decision: null, decidedAt: null };
  const [row] = await queryRows<{ admin_id: string; approver_admin_id: string | null; decision: string | null; decided_at: Date | null }>(
    getDb(),
    sql`SELECT a.admin_id, ap.approver_admin_id, ap.decision, ap.decided_at
          FROM admin_actions a
          LEFT JOIN admin_action_approvals ap ON ap.admin_action_id = a.id
         WHERE a.id = ${adminActionId}`,
  );
  return {
    adminActionId,
    initiatedBy: row?.admin_id ?? null,
    decidedBy: row?.approver_admin_id ?? null,
    decision: (row?.decision as 'approved' | 'rejected' | null) ?? null,
    decidedAt: row?.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

/** The detail DTO's approval chain: every decision on the action's `AdminAction`, as user ids. */
export async function approvalEntriesFor(adminActionId: string | null): Promise<ModerationApprovalEntryDto[]> {
  if (!adminActionId) return [];
  const rows = await queryRows<{ decision: 'approved' | 'rejected'; user_id: string; decided_at: Date }>(
    getDb(),
    sql`SELECT ap.decision, p.user_id, ap.decided_at
          FROM admin_action_approvals ap
          JOIN admin_profiles p ON p.id = ap.approver_admin_id
         WHERE ap.admin_action_id = ${adminActionId}
         ORDER BY ap.decided_at ASC`,
  );
  return rows.map((r) => ({ decision: r.decision, decidedByAdminUserId: r.user_id, decidedAt: new Date(r.decided_at).toISOString() }));
}

export interface ModerationAuditInput {
  actorUserId: string;
  eventType: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  approvalChain?: unknown;
  correlationId?: string | null;
  /** The appellant's own filing carries no admin role (§3.10). */
  asNonAdmin?: boolean;
}

export async function auditModeration(input: ModerationAuditInput): Promise<void> {
  const actorRoles = input.asNonAdmin ? [] : await getAdminRoleNames(input.actorUserId);
  const [resource, action] = input.eventType.split('.') as [string, string];
  await recordAdminAuditEvent({
    actorUserId: input.actorUserId,
    actorRoles,
    eventType: input.eventType,
    resource,
    action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason ?? null,
    approvalChain: input.approvalChain ?? [],
    correlationId: input.correlationId ?? null,
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
  });
}
