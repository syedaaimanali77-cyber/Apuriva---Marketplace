/**
 * Spec 032 §3 — assignment and reassignment (AC-5, AC-6).
 *
 * REASSIGNMENT DOES NOT RESET THE SLA DEADLINE, and that is the point of doing it here rather than
 * letting each caller decide. If handing a ticket to a colleague restarted its clock, passing it
 * around would be a way to erase a breach — so the new assignee inherits the original deadline
 * exactly. `lib/support/sla.integration.test.ts` asserts the deadline is byte-identical across an
 * assignment.
 *
 * THE TARGET MUST BE ABLE TO DO THE JOB. Assigning to an admin who does not hold `support/respond`
 * would produce a ticket nobody can reply to, so the target's permission is checked and a failure
 * is `422 SUPPORT_ASSIGNEE_NOT_ELIGIBLE` rather than a silent dead end.
 */
import { sql } from 'drizzle-orm';
import type { AdminSupportTicketDto } from '@/lib/types/support';
import { projectContext } from './context';
import { supportAssigneeNotEligibleError } from './errors';
import { applyTransition, assertTransitionAllowed, loadTicketRow } from './lifecycle';
import { hasSupportRespondPermission } from './permissions';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { toAdminSupportTicketDto } from './rows';
import type { ParsedAssign } from './validation';

export async function assignTicket(input: {
  adminUserId: string;
  ticketId: string;
  request: ParsedAssign;
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const current = await loadTicketRow(input.ticketId);
  if (current.status !== input.request.expectedStatus) {
    // Surfaced through the same 409 path every other transition uses.
    assertTransitionAllowed(current.status, 'assigned', 'admin');
  }

  // `open -> assigned` and the `assigned -> assigned` self-loop are both in the table; a ticket
  // that is `awaiting_user`, `resolved` or `closed` is refused here with the precise reason.
  assertTransitionAllowed(input.request.expectedStatus, 'assigned', 'admin');

  if (!(await hasSupportRespondPermission(input.request.assigneeUserId))) {
    throw supportAssigneeNotEligibleError();
  }

  const updated = await applyTransition(input.ticketId, input.request.expectedStatus, 'assigned', {
    extraSet: [sql`assigned_admin_user_id = ${input.request.assigneeUserId}`],
  });

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.ticketAssigned,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    details: { from: current.assigned_admin_user_id, to: input.request.assigneeUserId },
  });

  const context = await projectContext(input.adminUserId, updated.context_type, updated.context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated, context);
}
