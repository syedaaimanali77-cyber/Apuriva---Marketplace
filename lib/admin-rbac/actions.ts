import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminActionApprovals, adminActions } from '@/lib/db/schema';
import { recordAdminAuditEvent } from './audit';
import {
  adminActionNotFoundError,
  adminForbiddenError,
  approvalNotEligibleError,
  approvalRequiredError,
  selfApprovalNotAllowedError,
} from './errors';
import { getAdminProfileId, getAdminRoleNames, resolvePermission } from './permissions';
import type { AdminActionStatus, ApprovalDecision } from '@/lib/types/admin-rbac';

export interface InitiateActionInput {
  /** The initiating admin's `User.id` — resolved to their `AdminProfile` internally. */
  userId: string;
  resource: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  /** §3.2: only ever honored if the resolved risk tier is `critical`; low/medium/high requests
   * that pass this simply ignore it — this framework does not decide bypass eligibility itself
   * (that's the owning domain's job, before it ever calls this with `emergencyBypass: true`). */
  emergencyBypass?: boolean;
}

export type InitiateActionResult =
  | { outcome: 'permitted' }
  | { outcome: 'pending_approval'; adminActionId: string }
  | { outcome: 'emergency_bypass_executed'; adminActionId: string };

/**
 * Spec 009 §3.1 — the framework entry point every domain action calls before executing an
 * admin-gated `(resource, action)`. Resolves authorization + risk tier (§3.1 step 1), then either
 * permits immediately (low/medium, step 2), creates a `Pending` `AdminAction` (high/critical,
 * step 3), or — only when the caller explicitly requests it — executes via the emergency-bypass
 * path (§3.2), landing directly in `PostActionReviewRequired`.
 */
export async function authorizeAndInitiate(input: InitiateActionInput): Promise<InitiateActionResult> {
  const perm = await resolvePermission(input.userId, input.resource, input.action);
  if (!perm.allowed) throw adminForbiddenError();

  // AC-4: every audit event this function emits carries the acting admin's currently assigned
  // role(s) — fetched once and reused across whichever of the three branches below fires.
  const actorRoles = await getAdminRoleNames(input.userId);

  if (perm.riskTier === 'low' || perm.riskTier === 'medium') {
    await recordAdminAuditEvent({
      actorUserId: input.userId,
      actorRoles,
      eventType: 'admin_rbac.action_permitted',
      resource: input.resource,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      approvalChain: [],
    });
    return { outcome: 'permitted' };
  }

  // `allowed: true` guarantees riskTier is set (lib/admin-rbac/permissions.ts) — the low/medium
  // branch above already returned, so only 'high' | 'critical' remain.
  const riskTier = perm.riskTier as 'high' | 'critical';
  const adminProfileId = await getAdminProfileId(input.userId);
  if (!adminProfileId) throw adminForbiddenError();

  if (input.emergencyBypass && riskTier === 'critical') {
    const [row] = await getDb()
      .insert(adminActions)
      .values({
        adminId: adminProfileId,
        resource: input.resource,
        actionType: input.action,
        riskTier,
        status: 'PostActionReviewRequired',
        reason: input.reason,
        targetType: input.targetType,
        targetId: input.targetId,
        isEmergencyBypass: true,
      })
      .returning({ id: adminActions.id });

    await recordAdminAuditEvent({
      actorUserId: input.userId,
      actorRoles,
      eventType: 'admin_rbac.emergency_bypass_executed',
      resource: input.resource,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      isEmergencyBypass: true,
      approvalChain: { initiatedBy: adminProfileId, adminActionId: row!.id },
    });
    return { outcome: 'emergency_bypass_executed', adminActionId: row!.id };
  }

  const [row] = await getDb()
    .insert(adminActions)
    .values({
      adminId: adminProfileId,
      resource: input.resource,
      actionType: input.action,
      riskTier,
      status: 'Pending',
      reason: input.reason,
      targetType: input.targetType,
      targetId: input.targetId,
    })
    .returning({ id: adminActions.id });

  await recordAdminAuditEvent({
    actorUserId: input.userId,
    actorRoles,
    eventType: 'admin_rbac.action_created',
    resource: input.resource,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    approvalChain: { initiatedBy: adminProfileId },
  });
  return { outcome: 'pending_approval', adminActionId: row!.id };
}

type AdminActionRow = typeof adminActions.$inferSelect;

async function getAdminActionOrThrow(adminActionId: string): Promise<AdminActionRow> {
  const [row] = await getDb().select().from(adminActions).where(eq(adminActions.id, adminActionId));
  if (!row) throw adminActionNotFoundError();
  return row;
}

export interface DecideActionInput {
  /** The deciding admin's `User.id`. */
  approverUserId: string;
  adminActionId: string;
  decision: ApprovalDecision;
}

export interface DecideActionResult {
  adminActionId: string;
  status: AdminActionStatus;
  decision: ApprovalDecision;
  decidedAt: string;
  approvalId: string;
}

/**
 * Spec 009 §3/§6/§7 `POST /admin/approvals/{actionId}/approve|reject` — shared by both, since the
 * eligibility rules are identical: a different, authorized admin, deciding a still-`Pending`
 * action exactly once. The `WHERE status = 'Pending'` on the update is this framework's version of
 * spec 003's optimistic-concurrency CAS (lib/db/schema.ts's `version` column convention) — whoever
 * wins that conditional UPDATE is the decision that lands; a racing second decision matches zero
 * rows and surfaces as `APPROVAL_NOT_ELIGIBLE` rather than a silent double-decision.
 */
export async function decideAction(input: DecideActionInput): Promise<DecideActionResult> {
  const approverAdminProfileId = await getAdminProfileId(input.approverUserId);
  if (!approverAdminProfileId) throw adminForbiddenError();

  const action = await getAdminActionOrThrow(input.adminActionId);
  if (action.status !== 'Pending') throw approvalNotEligibleError();
  if (action.adminId === approverAdminProfileId) throw selfApprovalNotAllowedError();

  const perm = await resolvePermission(input.approverUserId, action.resource, action.actionType);
  if (!perm.allowed) throw approvalNotEligibleError('You are not authorized to decide this action.');

  const approverRoles = await getAdminRoleNames(input.approverUserId);

  const nextStatus: AdminActionStatus = input.decision === 'approved' ? 'Approved' : 'Rejected';
  const updated = await getDb()
    .update(adminActions)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(and(eq(adminActions.id, action.id), eq(adminActions.status, 'Pending')))
    .returning({ id: adminActions.id });
  if (updated.length === 0) throw approvalNotEligibleError();

  const [approval] = await getDb()
    .insert(adminActionApprovals)
    .values({ adminActionId: action.id, approverAdminId: approverAdminProfileId, decision: input.decision })
    .returning();

  await recordAdminAuditEvent({
    actorUserId: input.approverUserId,
    actorRoles: approverRoles,
    eventType: input.decision === 'approved' ? 'admin_rbac.action_approved' : 'admin_rbac.action_rejected',
    resource: action.resource,
    action: action.actionType,
    targetType: action.targetType,
    targetId: action.targetId,
    reason: action.reason,
    approvalChain: {
      initiatedBy: action.adminId,
      decidedBy: approverAdminProfileId,
      decision: input.decision,
      decidedAt: approval!.decidedAt,
    },
  });

  return {
    adminActionId: action.id,
    status: nextStatus,
    decision: input.decision,
    decidedAt: approval!.decidedAt.toISOString(),
    approvalId: approval!.id,
  };
}

/**
 * Spec 009 §3.1 step 3/§4.2 — the domain action calls this once it's actually ready to perform
 * the effect an `Approved` `AdminAction` gates. Moves `Approved` -> `Executed`. Calling this
 * against a still-`Pending` action (the domain skipped the approval flow) surfaces
 * `422 APPROVAL_REQUIRED`; calling it against anything else non-`Approved` (already `Executed`,
 * `Rejected`, or a review-only bypass state) surfaces `409 APPROVAL_NOT_ELIGIBLE`.
 */
export async function executeApprovedAction(adminActionId: string, executorUserId: string): Promise<void> {
  const action = await getAdminActionOrThrow(adminActionId);
  if (action.status === 'Pending') throw approvalRequiredError();
  if (action.status !== 'Approved') throw approvalNotEligibleError('This action is not in a state that can be executed.');

  const updated = await getDb()
    .update(adminActions)
    .set({ status: 'Executed', updatedAt: new Date() })
    .where(and(eq(adminActions.id, adminActionId), eq(adminActions.status, 'Approved')))
    .returning({ id: adminActions.id });
  if (updated.length === 0) throw approvalNotEligibleError('This action is not in a state that can be executed.');

  const executorRoles = await getAdminRoleNames(executorUserId);
  await recordAdminAuditEvent({
    actorUserId: executorUserId,
    actorRoles: executorRoles,
    eventType: 'admin_rbac.action_executed',
    resource: action.resource,
    action: action.actionType,
    targetType: action.targetType,
    targetId: action.targetId,
    reason: action.reason,
    approvalChain: { initiatedBy: action.adminId, executedBy: executorUserId },
  });
}

export interface RecordPostActionReviewInput {
  reviewerUserId: string;
  adminActionId: string;
  notes: string;
}

/**
 * Spec 009 §3.2/AC-3 `POST /admin/actions/{actionId}/post-action-review` — the only way an
 * emergency-bypassed `AdminAction` leaves `PostActionReviewRequired`. Cannot be silently closed:
 * every other framework operation on this action rejects while it sits in that status, and this
 * is the one path that moves it to the terminal `PostActionReviewed`.
 */
export async function recordPostActionReview(input: RecordPostActionReviewInput): Promise<{ id: string; postActionReviewedAt: string }> {
  const reviewerAdminProfileId = await getAdminProfileId(input.reviewerUserId);
  if (!reviewerAdminProfileId) throw adminForbiddenError();

  const action = await getAdminActionOrThrow(input.adminActionId);
  if (action.status !== 'PostActionReviewRequired') {
    throw approvalNotEligibleError('This action is not awaiting post-action review.');
  }

  const perm = await resolvePermission(input.reviewerUserId, action.resource, action.actionType);
  if (!perm.allowed) throw approvalNotEligibleError('You are not authorized to review this action.');

  const reviewerRoles = await getAdminRoleNames(input.reviewerUserId);
  const reviewedAt = new Date();
  const updated = await getDb()
    .update(adminActions)
    .set({
      status: 'PostActionReviewed',
      postActionReviewByAdminId: reviewerAdminProfileId,
      postActionReviewedAt: reviewedAt,
      postActionReviewNotes: input.notes,
      updatedAt: reviewedAt,
    })
    .where(and(eq(adminActions.id, action.id), eq(adminActions.status, 'PostActionReviewRequired')))
    .returning({ id: adminActions.id });
  if (updated.length === 0) throw approvalNotEligibleError('This action is not awaiting post-action review.');

  await recordAdminAuditEvent({
    actorUserId: input.reviewerUserId,
    actorRoles: reviewerRoles,
    eventType: 'admin_rbac.post_action_reviewed',
    resource: action.resource,
    action: action.actionType,
    targetType: action.targetType,
    targetId: action.targetId,
    reason: action.reason,
    isEmergencyBypass: true,
    approvalChain: { initiatedBy: action.adminId, reviewedBy: reviewerAdminProfileId, notes: input.notes },
  });

  return { id: action.id, postActionReviewedAt: reviewedAt.toISOString() };
}
