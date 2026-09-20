/**
 * Spec 032 §3 "Ticket lifecycle" (AC-7, AC-8) — every state change goes through here.
 *
 * ONE SHAPE FOR EVERY TRANSITION: a conditional `UPDATE ... WHERE id = $1 AND status =
 * $expectedStatus`, bumping `version` and stamping `updated_at` from `clock_timestamp()`. A
 * zero-row result means somebody else won the race, so the row is re-read and
 * `409 SUPPORT_TICKET_STATUS_CONFLICT` is raised carrying the status that actually won. That is
 * the whole of AC-7's concurrency story, and it is why two simultaneous callers produce exactly one
 * `200` and one `409` rather than two successes.
 *
 * THE SLA CLOCK IS ARITHMETIC IN SQL, NOT IN JAVASCRIPT. Entering `awaiting_user` stamps
 * `awaiting_user_since`; leaving it adds exactly the elapsed pause to `sla_deadline_at` and
 * accumulates it into `sla_paused_seconds`, in the SAME statement, reading the database clock once.
 * Doing it in two statements, or against the app server's clock, would let the pause and the
 * deadline drift apart.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { SupportTicketStatus } from '@/lib/types/support';
import { supportStatusConflictError, supportTicketNotFoundError, supportTransitionNotAllowedError } from './errors';
import { ADMIN_COLUMNS, type AdminTicketRow } from './rows';
import { canTransition, type SupportActor } from './transitions';

/** Loads the admin view of a ticket. Callers reach this only behind `support/read` or ownership. */
export async function loadTicketRow(ticketId: string, db: Executor = getDb()): Promise<AdminTicketRow> {
  if (!isUuid(ticketId)) throw supportTicketNotFoundError();
  const [row] = await queryRows<AdminTicketRow>(
    db,
    sql`SELECT ${sql.raw(ADMIN_COLUMNS)} FROM support_tickets WHERE id = ${ticketId}`,
  );
  if (!row) throw supportTicketNotFoundError();
  return row;
}

/**
 * Guards a move against the transition table BEFORE any write is attempted.
 *
 * Separated from the write so the reason a move is refused is precise: an illegal pair is
 * `422 SUPPORT_TRANSITION_NOT_ALLOWED` (it could never be legal), while losing a race to another
 * writer is `409 SUPPORT_TICKET_STATUS_CONFLICT` (it was legal, someone else got there first).
 * Collapsing the two would tell a caller to retry something that can never succeed.
 */
export function assertTransitionAllowed(
  from: SupportTicketStatus,
  to: SupportTicketStatus,
  actor: SupportActor,
): void {
  if (!canTransition(from, to, actor)) throw supportTransitionNotAllowedError(from, to);
}

export interface TransitionOptions {
  /** Extra `SET` assignments, already parameterized. */
  extraSet?: ReturnType<typeof sql>[];
  /** Additional `WHERE` predicates beyond the id/status guard. */
  extraWhere?: ReturnType<typeof sql>[];
}

/**
 * The single conditional write. Returns the updated row, or throws `409` if the guard did not hold.
 *
 * `expectedStatus` is supplied by the CALLER — for an admin route it comes from the request body,
 * so an admin acting on a stale screen is told the ticket moved rather than silently overwriting
 * whatever happened in between.
 */
export async function applyTransition(
  ticketId: string,
  expectedStatus: SupportTicketStatus,
  nextStatus: SupportTicketStatus,
  options: TransitionOptions = {},
  db: Executor = getDb(),
): Promise<AdminTicketRow> {
  const sets = [sql`status = ${nextStatus}`, ...(options.extraSet ?? [])];
  const wheres = [sql`id = ${ticketId}`, sql`status = ${expectedStatus}`, ...(options.extraWhere ?? [])];

  const updated = await queryRows<AdminTicketRow>(
    db,
    sql`UPDATE support_tickets
           SET ${sql.join(sets, sql`, `)}, updated_at = clock_timestamp(), version = version + 1
         WHERE ${sql.join(wheres, sql` AND `)}
        RETURNING ${sql.raw(ADMIN_COLUMNS)}`,
  );

  if (!updated[0]) throw supportStatusConflictError((await loadTicketRow(ticketId, db)).status);
  return updated[0];
}

/**
 * AC-8 — the `SET` fragment for ENTERING `awaiting_user`. Starts the pause.
 *
 * Paired with `support_tickets_awaiting_pairing_ck`, which makes it impossible to be in
 * `awaiting_user` without a stamp or to carry a stamp outside it.
 */
export function beginAwaitingUser(): ReturnType<typeof sql> {
  return sql`awaiting_user_since = clock_timestamp()`;
}

/**
 * AC-8 — the `SET` fragment for LEAVING `awaiting_user`.
 *
 * Pushes the deadline forward by exactly the elapsed pause and banks the same interval into
 * `sla_paused_seconds`, so a later priority change can recompute from creation without losing it.
 * `coalesce` keeps this safe if it is ever reached from a state with no stamp.
 *
 * This is what makes AC-8's promise literally true: a user's own delay cannot breach their ticket.
 */
export function endAwaitingUser(): ReturnType<typeof sql> {
  return sql`sla_deadline_at = sla_deadline_at + (clock_timestamp() - coalesce(awaiting_user_since, clock_timestamp())),
             sla_paused_seconds = sla_paused_seconds
               + floor(extract(epoch from (clock_timestamp() - coalesce(awaiting_user_since, clock_timestamp()))))::int,
             awaiting_user_since = NULL`;
}
