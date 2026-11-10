/**
 * Spec 032 §3 — the admin support workspace's reads (AC-5).
 *
 * THE INBOX IS THE WHOLE OF MASTER §63's LIST, and the filters are the ones an admin actually works
 * by: status, priority, category, "mine", and breached. Sorted by SLA deadline ascending by
 * default, because the queue's job is to surface what is running out of time — `slaBreached` is
 * computed in the projection (`toAdminSupportTicketSummaryDto`), not stored, so it can never go
 * stale relative to the clock.
 *
 * NOTHING HERE WIDENS ANOTHER SPEC'S EXPOSURE. The context is projected as a pointer plus one
 * neutral status string (DECIDED-6); the workspace links into spec 021/022/031's own permissioned
 * surfaces for the detail, and an admin without those permissions simply cannot follow the link.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { PageParams } from '@/lib/api/pagination';
import type {
  AdminSupportTicketDto,
  AdminSupportTicketSummaryDto,
  SupportCategory,
  SupportPriority,
  SupportTicketStatus,
} from '@/lib/types/support';
import { projectContext } from './context';
import { loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { ADMIN_COLUMNS, toAdminSupportTicketDto, toAdminSupportTicketSummaryDto, type AdminTicketRow } from './rows';

export interface SupportInboxFilters {
  status?: SupportTicketStatus;
  priority?: SupportPriority;
  category?: SupportCategory;
  /** Restricts to tickets assigned to the calling admin. */
  assignedToMe?: boolean;
  /** AC-8 — the breach predicate, expressed in SQL so it can page and sort. */
  slaBreached?: boolean;
  sort?: 'slaDeadlineAt' | 'createdAt';
}

export async function listSupportInbox(
  adminUserId: string,
  filters: SupportInboxFilters,
  page: PageParams,
): Promise<{ items: AdminSupportTicketSummaryDto[]; total: number }> {
  const db = getDb();
  const now = new Date();

  const wheres = [sql`true`];
  if (filters.status) wheres.push(sql`status = ${filters.status}`);
  if (filters.priority) wheres.push(sql`priority = ${filters.priority}`);
  if (filters.category) wheres.push(sql`category = ${filters.category}`);
  if (filters.assignedToMe) wheres.push(sql`assigned_admin_user_id = ${adminUserId}`);
  if (filters.slaBreached !== undefined) {
    // Mirrors `isSlaBreached()` exactly: a paused (`awaiting_user`) ticket is never breached, and
    // neither is one past resolution. Keeping the two in step is what
    // `lib/support/sla.integration.test.ts` checks.
    const breached = sql`(status NOT IN ('awaiting_user','resolved','closed') AND sla_deadline_at < clock_timestamp())`;
    wheres.push(filters.slaBreached ? breached : sql`NOT ${breached}`);
  }
  const where = sql.join(wheres, sql` AND `);

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM support_tickets WHERE ${where}`,
  );

  const order =
    filters.sort === 'createdAt' ? sql`created_at DESC` : sql`sla_deadline_at ASC`;

  const rows = await queryRows<AdminTicketRow>(
    db,
    sql`SELECT ${sql.raw(ADMIN_COLUMNS)} FROM support_tickets
         WHERE ${where}
         ORDER BY ${order}, id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: rows.map((row) => toAdminSupportTicketSummaryDto(row, now)), total: countRow?.total ?? 0 };
}

/**
 * One ticket in full.
 *
 * READING IS AUDITED. Reading someone's support ticket decides nothing, but it is still something
 * an admin did to a person's record, and it should be attributable — spec 031's rule for its
 * dispute reads, applied here for the same reason.
 */
export async function getTicketForAdmin(
  adminUserId: string,
  ticketId: string,
  correlationId: string | null,
): Promise<AdminSupportTicketDto> {
  const db = getDb();
  const row = await loadTicketRow(ticketId, db);

  await auditSupport({
    adminUserId,
    eventType: SUPPORT_EVENT_TYPES.ticketRead,
    targetId: ticketId,
    correlationId,
  });

  const context = await projectContext(adminUserId, row.context_type, row.context_id, { viewerIsAdmin: true }, db);
  return toAdminSupportTicketDto(row, context);
}

/** Whether this admin raised the ticket themselves — the participant/admin conflict check. */
export async function isRequesterOfTicket(ticketId: string, userId: string): Promise<boolean> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM support_tickets WHERE id = ${ticketId} AND requester_user_id = ${userId}`,
  );
  return Boolean(row);
}
