/**
 * Spec 032 §3 "Categories and priority" (AC-4, AC-6) — the ONLY way a priority ever moves after
 * creation.
 *
 * HUMAN-SET AND AUDITED WITH BOTH VALUES, exactly as spec 030's `setSafetyPriority()` does. Nothing
 * here is derived from the ticket's content: no heuristic, no text analysis and no AI — this
 * function takes a priority an authorized human chose and records who chose it and why.
 *
 * IT RECOMPUTES THE SLA DEADLINE, which is why `support/triage` is `medium` rather than `low`.
 * The recomputation is anchored to `created_at` plus the pause already banked, NOT to now — see
 * `recomputeSlaDeadline`. Anchoring to now would make re-prioritising a way to buy time.
 *
 * The status is NOT changed: triage answers "how urgent is this", not "where is it in its life".
 * `expectedStatus` guards the write so an admin acting on a stale screen is told the ticket moved.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { AdminSupportTicketDto } from '@/lib/types/support';
import { projectContext } from './context';
import { supportStatusConflictError, supportTicketClosedError } from './errors';
import { loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { ADMIN_COLUMNS, toAdminSupportTicketDto, type AdminTicketRow } from './rows';
import { slaHoursFor } from './sla';
import { isTriageableStatus } from './transitions';
import type { ParsedPriorityChange } from './validation';

export async function setTicketPriority(input: {
  adminUserId: string;
  ticketId: string;
  request: ParsedPriorityChange;
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const db = getDb();
  const current = await loadTicketRow(input.ticketId, db);

  // A resolved or closed ticket has no response deadline left to move.
  if (!isTriageableStatus(current.status)) throw supportTicketClosedError();
  if (current.status !== input.request.expectedStatus) throw supportStatusConflictError(current.status);

  const hours = slaHoursFor(input.request.priority);

  // The deadline is rebuilt from `created_at` + the new priority's hours + every second already
  // spent waiting on the user, plus the pause currently open if there is one. All in one statement,
  // reading the clock once.
  const updated = await queryRows<AdminTicketRow>(
    db,
    sql`UPDATE support_tickets
           SET priority = ${input.request.priority},
               sla_deadline_at = created_at
                 + make_interval(hours => ${hours})
                 + make_interval(secs => sla_paused_seconds)
                 + CASE WHEN awaiting_user_since IS NULL
                        THEN interval '0'
                        ELSE clock_timestamp() - awaiting_user_since END,
               updated_at = clock_timestamp(),
               version = version + 1
         WHERE id = ${input.ticketId} AND status = ${input.request.expectedStatus}
        RETURNING ${sql.raw(ADMIN_COLUMNS)}`,
  );

  if (!updated[0]) throw supportStatusConflictError((await loadTicketRow(input.ticketId, db)).status);

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.priorityChanged,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    reason: input.request.reason,
    details: { from: current.priority, to: input.request.priority },
  });

  const context = await projectContext(input.adminUserId, updated[0].context_type, updated[0].context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated[0], context);
}
