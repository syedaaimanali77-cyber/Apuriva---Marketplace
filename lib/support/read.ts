/**
 * Spec 032 §3 — the REQUESTER's reads (AC-3).
 *
 * Every query here is scoped by `requester_user_id` in its `WHERE`, not filtered afterwards, so
 * there is no code path that could widen one. A ticket belonging to someone else is `404`, never
 * `403` — a `403` would confirm the id exists, which is itself information about another person's
 * problem.
 *
 * NOTHING IN THIS FILE SELECTS FROM `support_notes`. That is the structural half of AC-3: an
 * internal note cannot leak to a requester through a projection bug, because no participant query
 * reads the table at all.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { PageParams } from '@/lib/api/pagination';
import type { SupportMessageDto, SupportTicketDto, SupportTicketSummaryDto } from '@/lib/types/support';
import { projectContext } from './context';
import { supportTicketNotFoundError } from './errors';
import {
  PARTICIPANT_COLUMNS,
  toSupportMessageDto,
  toSupportTicketDto,
  toSupportTicketSummaryDto,
  type ParticipantTicketRow,
  type SupportMessageRow,
} from './rows';

/** The caller's own tickets, newest first. Scoped by `requester_user_id`; it cannot widen. */
export async function listTicketsForUser(
  userId: string,
  page: PageParams,
): Promise<{ items: SupportTicketSummaryDto[]; total: number }> {
  const db = getDb();

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM support_tickets WHERE requester_user_id = ${userId}`,
  );

  const rows = await queryRows<ParticipantTicketRow>(
    db,
    sql`SELECT ${sql.raw(PARTICIPANT_COLUMNS)} FROM support_tickets
         WHERE requester_user_id = ${userId}
         ORDER BY created_at DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: rows.map(toSupportTicketSummaryDto), total: countRow?.total ?? 0 };
}

/** Loads a ticket the caller must be the requester of. Used by both the read and the write paths. */
export async function loadOwnTicketRow(
  userId: string,
  ticketId: string,
  db: Executor = getDb(),
): Promise<ParticipantTicketRow> {
  if (!isUuid(ticketId)) throw supportTicketNotFoundError();
  const [row] = await queryRows<ParticipantTicketRow>(
    db,
    sql`SELECT ${sql.raw(PARTICIPANT_COLUMNS)} FROM support_tickets
         WHERE id = ${ticketId} AND requester_user_id = ${userId}`,
  );
  if (!row) throw supportTicketNotFoundError();
  return row;
}

export async function getTicketForRequester(userId: string, ticketId: string): Promise<SupportTicketDto> {
  const db = getDb();
  const row = await loadOwnTicketRow(userId, ticketId, db);

  const [countRow] = await queryRows<{ count: number }>(
    db,
    sql`SELECT count(*)::int AS count FROM support_messages WHERE support_ticket_id = ${row.id}`,
  );
  // Re-resolved live on every read (DECIDED-6), and degrading to `available: false` rather than
  // failing the read, so a ticket never becomes unopenable because its subject changed.
  const context = await projectContext(userId, row.context_type, row.context_id, {}, db);

  return toSupportTicketDto(row, context, countRow?.count ?? 0);
}

/** Is this user the ticket's requester? Used by the shared messages route to pick its path. */
export async function isRequesterOf(ticketId: string, userId: string, db: Executor = getDb()): Promise<boolean> {
  if (!isUuid(ticketId)) return false;
  const [row] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM support_tickets WHERE id = ${ticketId} AND requester_user_id = ${userId}`,
  );
  return Boolean(row);
}

/**
 * The thread, OLDEST FIRST, so it reads as a record of an exchange rather than as a chat feed.
 *
 * There are deliberately no read receipts and no unread counts — those are spec 025's conversation
 * features and are not reproduced here.
 */
export async function listMessages(
  ticketId: string,
  viewerUserId: string,
  page: PageParams,
): Promise<{ items: SupportMessageDto[]; total: number }> {
  const db = getDb();

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM support_messages WHERE support_ticket_id = ${ticketId}`,
  );

  const rows = await queryRows<SupportMessageRow>(
    db,
    sql`SELECT id, sender_user_id, body, is_admin, created_at FROM support_messages
         WHERE support_ticket_id = ${ticketId}
         ORDER BY created_at ASC, id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: rows.map((row) => toSupportMessageDto(row, viewerUserId)), total: countRow?.total ?? 0 };
}
