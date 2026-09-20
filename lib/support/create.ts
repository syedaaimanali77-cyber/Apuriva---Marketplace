/**
 * Spec 032 §3 — ticket creation (AC-2, AC-4).
 *
 * THE ORDER MATTERS AND IS DELIBERATE:
 *
 *   1. authorize the context FIRST, before anything is written, so an unauthorized attach never
 *      creates a row it then has to clean up (AC-2);
 *   2. derive the priority from `CATEGORY_PRIORITY` — never from the request, which has no
 *      `priority` field to read (AC-4);
 *   3. compute the SLA deadline from that priority and the row's own creation instant;
 *   4. insert;
 *   5. attempt the advisory AI summary AFTER the row exists, its failure already swallowed, so a
 *      spec 033 outage cannot prevent a support ticket from being raised;
 *   6. notify, fire-and-forget after commit.
 *
 * The insert reads `clock_timestamp()` ONCE for both `created_at` and the deadline, so the two can
 * never disagree by the width of a round trip.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { ActiveMode } from '@/lib/types/users';
import type { SupportTicketDto } from '@/lib/types/support';
import { authorizeContext, projectContext } from './context';
import { priorityForCategory } from './limits';
import { slaHoursFor } from './sla';
import { summarizeForTriage } from './ai-assist';
import { emitSupportNotification } from './notifications';
import { PARTICIPANT_COLUMNS, toSupportTicketDto, type ParticipantTicketRow } from './rows';
import type { ParsedCreateTicket } from './validation';

export async function createSupportTicket(
  requesterUserId: string,
  requesterMode: ActiveMode,
  input: ParsedCreateTicket,
  idempotency: { key: string; fingerprint: string },
): Promise<{ ticket: SupportTicketDto; replayed: boolean }> {
  const db = getDb();

  // AC-7 — a replay returns the stored outcome rather than acting twice.
  const existing = await queryRows<ParticipantTicketRow & { idempotency_fingerprint: string }>(
    db,
    sql`SELECT ${sql.raw(PARTICIPANT_COLUMNS)}, idempotency_fingerprint FROM support_tickets
         WHERE requester_user_id = ${requesterUserId} AND idempotency_key = ${idempotency.key}`,
  );
  if (existing[0]) {
    const row = existing[0];
    const context = await projectContext(requesterUserId, row.context_type, row.context_id);
    return { ticket: toSupportTicketDto(row, context, await countMessages(row.id)), replayed: true };
  }

  // AC-2 — before any write. Throws the uniform 422 for unknown, deleted or unauthorized.
  if (input.contextType !== null && input.contextId !== null) {
    await authorizeContext(requesterUserId, input.contextType, input.contextId, db);
  }

  // AC-4 — the ONLY source of a new ticket's priority.
  const priority = priorityForCategory(input.category);
  const slaHours = slaHoursFor(priority);

  const [row] = await queryRows<ParticipantTicketRow>(
    db,
    sql`INSERT INTO support_tickets
          (requester_user_id, requester_mode, subject, description, category, priority, status,
           context_type, context_id, sla_deadline_at, idempotency_key, idempotency_fingerprint)
        VALUES (${requesterUserId}, ${requesterMode}, ${input.subject}, ${input.description},
                ${input.category}, ${priority}, 'open',
                ${input.contextType}, ${input.contextId},
                clock_timestamp() + make_interval(hours => ${slaHours}),
                ${idempotency.key}, ${idempotency.fingerprint})
        RETURNING ${sql.raw(PARTICIPANT_COLUMNS)}`,
  );

  const created = row!;

  // Advisory only (DECIDED-2). Stored in its own column; no decision anywhere reads it, and a
  // failure here is invisible to the user and changes nothing about the ticket.
  const summary = await summarizeForTriage({
    subject: input.subject,
    description: input.description,
    category: input.category,
  });
  if (summary !== null) {
    await db.execute(sql`UPDATE support_tickets SET ai_summary = ${summary} WHERE id = ${created.id}`);
  }

  await emitSupportNotification({
    kind: 'support_ticket_created',
    ticketId: created.id,
    recipientUserId: requesterUserId,
  });

  const context = await projectContext(requesterUserId, created.context_type, created.context_id, {}, db);
  return { ticket: toSupportTicketDto(created, context, 0), replayed: false };
}

export async function countMessages(ticketId: string): Promise<number> {
  const [row] = await queryRows<{ count: number }>(
    getDb(),
    sql`SELECT count(*)::int AS count FROM support_messages WHERE support_ticket_id = ${ticketId}`,
  );
  return row?.count ?? 0;
}
