/**
 * Spec 032 §8 "Audit events" (AC-6, DECIDED-10) — emission through spec 009's
 * `recordAdminAuditEvent()`, and nothing else.
 *
 * NO SECOND AUDIT SYSTEM. Spec 039 owns audit storage, retention and querying and HAS NOT SHIPPED —
 * there is no `lib/audit` in this repository. So this writes through spec 009's existing emitter
 * into `security_events`, exactly as specs 023/025/029/030/031 do, and builds no table, no sink and
 * no reader of its own. The nine event types are namespaced `support.*` so that when spec 039
 * builds real audit querying over whatever store it ends up owning, it inherits them unchanged.
 *
 * THERE IS NEVER AN APPROVAL CHAIN TO CARRY, and that is a statement rather than an omission:
 * every `support/*` permission is `low`/`medium`, so no support action requires approval and none
 * is initiated through `authorizeAndInitiate()`. The field carries this spec's `details` instead —
 * the same use spec 030's `auditSafety()` makes of it, for the same reason.
 *
 * READING IS AUDITED TOO. `support.ticket_read` fires on the admin DETAIL read — spec 031's rule:
 * reading someone's support ticket is not deciding anything, but it is still a thing an admin did
 * to a person's record, and it should be attributable.
 */
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';

export const SUPPORT_EVENT_TYPES = {
  ticketRead: 'support.ticket_read',
  ticketAssigned: 'support.ticket_assigned',
  priorityChanged: 'support.priority_changed',
  noteAdded: 'support.note_added',
  adminReplied: 'support.admin_replied',
  ticketResolved: 'support.ticket_resolved',
  ticketReopened: 'support.ticket_reopened',
  ticketClosed: 'support.ticket_closed',
  handedOff: 'support.handed_off',
} as const;

export type SupportEventType = (typeof SUPPORT_EVENT_TYPES)[keyof typeof SUPPORT_EVENT_TYPES];

/** The spec 009 `action` each event is recorded under — the permission that authorized it. */
const ACTION_BY_EVENT: Record<SupportEventType, string> = {
  'support.ticket_read': 'read',
  'support.ticket_assigned': 'assign',
  'support.priority_changed': 'triage',
  'support.note_added': 'respond',
  'support.admin_replied': 'respond',
  'support.ticket_resolved': 'resolve',
  'support.ticket_reopened': 'resolve',
  'support.ticket_closed': 'resolve',
  'support.handed_off': 'resolve',
};

export async function auditSupport(input: {
  adminUserId: string;
  eventType: SupportEventType;
  targetId: string;
  correlationId: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await recordAdminAuditEvent({
    actorUserId: input.adminUserId,
    actorRoles: await getAdminRoleNames(input.adminUserId),
    eventType: input.eventType,
    resource: 'support',
    action: ACTION_BY_EVENT[input.eventType],
    targetType: 'support_ticket',
    targetId: input.targetId,
    reason: input.reason ?? null,
    // Never an approval chain — see the module note.
    approvalChain: input.details ?? {},
    correlationId: input.correlationId,
  });
}
