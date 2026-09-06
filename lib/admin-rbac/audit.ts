import { recordSecurityEvent } from '@/lib/auth/security-event';
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
}

/**
 * Spec 009 §3.1.4/AC-4: emits the actor/role/action/target/reason/approval-chain data spec 039's
 * audit log requires. Spec 039 owns audit storage, retention, and admin audit access — this
 * reuses spec 005's general-purpose `security_events` table (already reused by spec 008 for its
 * own privacy-adjacent events) rather than standing up a second audit-storage system ahead of
 * spec 039 actually existing. `eventType` values are namespaced `admin_rbac.*` so they're easy to
 * find once spec 039 builds real audit-log querying on top of whatever store it ends up owning.
 */
export async function recordAdminAuditEvent(input: AdminAuditEventInput): Promise<void> {
  await recordSecurityEvent({
    userId: input.actorUserId,
    eventType: input.eventType,
    severity: 'info',
    metadata: {
      actorRoles: input.actorRoles,
      resource: input.resource,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      approvalChain: input.approvalChain,
      isEmergencyBypass: input.isEmergencyBypass ?? false,
    },
  });
}
