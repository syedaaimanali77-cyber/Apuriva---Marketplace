import { writeAuditEntry } from '@/lib/audit/write';
import type { AdminRole } from '@/lib/types/admin-rbac';

export interface AdminAuditEventInput {
  actorUserId: string;
  /** The acting admin's currently assigned roles (per `getAdminRoleNames`,
   * lib/admin-rbac/permissions.ts) at the moment of the action — AC-4 requires "actor, role,
   * action, target, reason, and approval chain"; an admin may hold more than one role
   * simultaneously (§4: "one or more of the seven roles"), so this is every role they held, not a
   * single one arbitrarily chosen. */
  actorRoles: AdminRole[];
  eventType: string;
  resource: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  /** §3.1.4/AC-4: empty for an action that needed no approval, the initiator (+ every
   * approval/rejection decision) for one that did, or the emergency-bypass marker + review outcome
   * for a bypassed action. */
  approvalChain: unknown;
  isEmergencyBypass?: boolean;
  /** Spec 039 AC-6 / spec 025 AC-5: links the audit entry back to the originating API request. Optional,
   * so every existing caller is unaffected. */
  correlationId?: string | null;
  /** Spec 037 AC-5 (X-1): the changed value BEFORE the write. Optional and additive — recorded only
   * when provided, so every existing caller's event is unchanged. Storage, retention and viewing
   * stay spec 039's. */
  before?: unknown;
  /** Spec 037 AC-5 (X-1): the changed value AFTER the write. Same rules as `before`. */
  after?: unknown;
  /** Spec 039 X-2: the `admin_actions.id` of the spec 009 `AdminAction` this event belongs to.
   * Optional and additive; when absent, an `adminActionId` in `approvalChain` is used instead. */
  approvalRef?: string | null;
}

/**
 * Spec 009 §3.1.4/AC-4: emits the actor/role/action/target/reason/approval-chain data of master
 * spec §72 — the ONE shared admin audit write path every domain module calls (spec 039 D-9).
 *
 * Spec 039 (X-2) made it durable: each call writes exactly one immutable row to `audit_logs`
 * through `writeAuditEntry()` and NOTHING to spec 005's `security_events`, which keeps only its own
 * security events (spec 039 §3.4). An admin actor is recorded as `admin`; a caller with no admin
 * role (e.g. spec 038's appellant, `actorRoles: []`) as `user`. A missing `correlationId` is taken
 * from the current API request's context. A failed write is signalled and rethrown, never swallowed.
 */
export async function recordAdminAuditEvent(input: AdminAuditEventInput): Promise<void> {
  await writeAuditEntry({
    actorType: input.actorRoles.length > 0 ? 'admin' : 'user',
    actorUserId: input.actorUserId,
    actorRoles: input.actorRoles,
    eventType: input.eventType,
    resource: input.resource,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    reason: input.reason ?? null,
    before: input.before,
    after: input.after,
    approvalRef: input.approvalRef ?? null,
    approvalChain: input.approvalChain,
    isEmergencyBypass: input.isEmergencyBypass ?? false,
    correlationId: input.correlationId ?? null,
  });
}
