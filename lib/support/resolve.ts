/**
 * Spec 032 §3 — resolution, reopen and closure (AC-6, AC-7, AC-9).
 *
 * AC-9 IS ENFORCED TWICE, DELIBERATELY. `assertResolutionAllowed()` refuses to resolve a
 * `safety`-category ticket as `answered` with a clear message, AND
 * `support_tickets_safety_resolution_ck` refuses the same write at the database. The application
 * check exists to explain; the constraint exists to guarantee — so no future route, migration or
 * bug can quietly let support adjudicate a safety matter.
 *
 * NOTHING HERE MOVES MONEY, SANCTIONS ANYONE, OR DECIDES A DISPUTE. A resolution records what
 * support did and why; the consequential workflows all belong to other specs and are reached only
 * through `handoff.ts`, which records a pointer and stops.
 * `lib/support/no-consequential-action.test.ts` asserts that at source level.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { AdminSupportTicketDto, SupportTicketDto } from '@/lib/types/support';
import { projectContext } from './context';
import {
  supportReopenLimitReachedError,
  supportReopenWindowElapsedError,
  supportResolutionInvalidError,
  supportStatusConflictError,
} from './errors';
import { applyTransition, assertTransitionAllowed, endAwaitingUser, loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { emitSupportNotification } from './notifications';
import { hasReopenWindowElapsed, MAX_REQUESTER_REOPENS, reopenWindowEndsAt } from './reopen-window';
import { loadOwnTicketRow } from './read';
import { PARTICIPANT_COLUMNS, toAdminSupportTicketDto, toSupportTicketDto, type ParticipantTicketRow } from './rows';
import { countMessages } from './create';
import type { ParsedResolve } from './validation';

/**
 * AC-9 — support owns the conversation, not the consequence.
 *
 * A `safety` ticket may be handed to spec 030 or recorded as not actionable. It may NEVER be
 * "answered", because answering it would mean a Support Admin had judged a safety matter.
 */
export function assertResolutionAllowed(category: string, resolutionKind: string): void {
  if (category === 'safety' && resolutionKind === 'answered') {
    throw supportResolutionInvalidError(
      'A safety ticket cannot be resolved as answered. Hand it off to the safety workflow, or record it as not actionable.',
    );
  }
}

export async function resolveTicket(input: {
  adminUserId: string;
  ticketId: string;
  request: ParsedResolve;
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const current = await loadTicketRow(input.ticketId);
  assertTransitionAllowed(input.request.expectedStatus, 'resolved', 'admin');
  assertResolutionAllowed(current.category, input.request.resolutionKind);

  const updated = await applyTransition(input.ticketId, input.request.expectedStatus, 'resolved', {
    extraSet: [
      sql`resolution_kind = ${input.request.resolutionKind}`,
      sql`resolution_reason = ${input.request.reason}`,
      sql`handoff_target = ${input.request.handoffTarget}`,
      sql`resolved_at = clock_timestamp()`,
      // A ticket resolved straight out of `awaiting_user` must not keep a dangling pause stamp:
      // `support_tickets_awaiting_pairing_ck` forbids one outside that state.
      ...(input.request.expectedStatus === 'awaiting_user' ? [endAwaitingUser()] : []),
    ],
  });

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.ticketResolved,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    reason: input.request.reason,
    details: { resolutionKind: input.request.resolutionKind, handoffTarget: input.request.handoffTarget },
  });

  const reopenBy = reopenWindowEndsAt(updated.resolved_at);
  await emitSupportNotification({
    kind: 'support_ticket_resolved',
    ticketId: input.ticketId,
    recipientUserId: updated.requester_user_id,
    reopenBy: reopenBy ? reopenBy.toISOString() : '',
  });

  const context = await projectContext(input.adminUserId, updated.context_type, updated.context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated, context);
}

/**
 * The REQUESTER's reopen — capped at one (`MAX_REQUESTER_REOPENS`).
 *
 * Spec 031's one-appeal rule, for the same reason: an unbounded reopen makes `closed` unreachable,
 * and a ticket that can never end is one nobody can be accountable for. An admin's reopen does not
 * consume this, which is why `support_tickets_reopen_count_ck` allows up to 2.
 */
export async function reopenTicketAsRequester(
  userId: string,
  ticketId: string,
): Promise<SupportTicketDto> {
  const db = getDb();
  const row = await loadOwnTicketRow(userId, ticketId, db);

  assertTransitionAllowed(row.status, 'assigned', 'requester');
  if (hasReopenWindowElapsed(row.resolved_at)) throw supportReopenWindowElapsedError();
  if (row.reopen_count >= MAX_REQUESTER_REOPENS) throw supportReopenLimitReachedError();

  const updated = await applyTransition(
    ticketId,
    'resolved',
    'assigned',
    {
      extraSet: [
        sql`reopen_count = reopen_count + 1`,
        // The resolution is withdrawn, not kept alongside a live ticket:
        // `support_tickets_resolution_pairing_ck` requires all three to move together.
        sql`resolution_kind = NULL`,
        sql`resolution_reason = NULL`,
        sql`handoff_target = NULL`,
        sql`resolved_at = NULL`,
      ],
      // Belt and braces against a concurrent second reopen slipping past the read above.
      extraWhere: [sql`reopen_count < ${MAX_REQUESTER_REOPENS}`],
    },
    db,
  );

  const context = await projectContext(userId, updated.context_type, updated.context_id, {}, db);
  const participantRow = updated as unknown as ParticipantTicketRow;
  return toSupportTicketDto(participantRow, context, await countMessages(ticketId));
}

/** An admin's reopen. Inside the same window, but it does not consume the requester's one. */
export async function reopenTicketAsAdmin(input: {
  adminUserId: string;
  ticketId: string;
  reason: string;
  expectedStatus: 'resolved';
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const current = await loadTicketRow(input.ticketId);
  assertTransitionAllowed(current.status, 'assigned', 'admin');
  if (current.status !== input.expectedStatus) throw supportStatusConflictError(current.status);
  if (hasReopenWindowElapsed(current.resolved_at)) throw supportReopenWindowElapsedError();

  const updated = await applyTransition(input.ticketId, 'resolved', 'assigned', {
    extraSet: [
      sql`resolution_kind = NULL`,
      sql`resolution_reason = NULL`,
      sql`handoff_target = NULL`,
      sql`resolved_at = NULL`,
    ],
  });

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.ticketReopened,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    reason: input.reason,
    details: { by: 'admin' },
  });

  const context = await projectContext(input.adminUserId, updated.context_type, updated.context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated, context);
}

/** The requester accepting the resolution early. `closed` is terminal from here. */
export async function closeTicketAsRequester(userId: string, ticketId: string): Promise<SupportTicketDto> {
  const db = getDb();
  const row = await loadOwnTicketRow(userId, ticketId, db);
  assertTransitionAllowed(row.status, 'closed', 'requester');

  const updated = await applyTransition(
    ticketId,
    'resolved',
    'closed',
    { extraSet: [sql`closed_at = clock_timestamp()`] },
    db,
  );

  const context = await projectContext(userId, updated.context_type, updated.context_id, {}, db);
  const participantRow = updated as unknown as ParticipantTicketRow;
  return toSupportTicketDto(participantRow, context, await countMessages(ticketId));
}

/** An admin closing a resolved ticket. Notifies nobody — the user was told at resolution. */
export async function closeTicketAsAdmin(input: {
  adminUserId: string;
  ticketId: string;
  correlationId: string | null;
}): Promise<AdminSupportTicketDto> {
  const current = await loadTicketRow(input.ticketId);
  assertTransitionAllowed(current.status, 'closed', 'admin');

  const updated = await applyTransition(input.ticketId, 'resolved', 'closed', {
    extraSet: [sql`closed_at = clock_timestamp()`],
  });

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.ticketClosed,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    details: { by: 'admin' },
  });

  const context = await projectContext(input.adminUserId, updated.context_type, updated.context_id, {
    viewerIsAdmin: true,
  });
  return toAdminSupportTicketDto(updated, context);
}
