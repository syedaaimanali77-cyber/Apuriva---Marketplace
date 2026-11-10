/**
 * Spec 032 §3 "Messages" (DECIDED-7) — the user-to-platform thread.
 *
 * NOT A SPEC 025 CONVERSATION, and the reason is structural rather than stylistic. Spec 025 models
 * a booking-scoped TWO-PARTY thread with a block gate, read receipts, unread counts and a retention
 * sweep. A support thread has an admin as a third participant, must survive a block between the two
 * users, is retained as an operational record rather than swept, and must not appear in the user's
 * message inbox beside their provider chats. Reusing `conversations` would need a null booking, a
 * null counterparty, a bypassed block gate and an exempted sweep — four holes punched in spec 025's
 * own invariants. So this is its own table, exactly as spec 031 reasoned for `dispute_messages`.
 *
 * WHAT *IS* REUSED: spec 025's `MESSAGE_BODY_MAX_LENGTH` (through `MAX_SUPPORT_BODY_LENGTH`) and
 * its `applyContactPolicy()`. No second prose bound, no second contact filter.
 *
 * CONTACT DETAILS ARE FLAGGED, NEVER MASKED. `applyContactPolicy(body, true)` keeps the body
 * verbatim and raises the Trust & Safety signal. Masking would be actively harmful here: "my phone
 * +44… isn't receiving codes" is the entire content of a legitimate `account` ticket, and redacting
 * it would make the ticket unanswerable.
 *
 * APPEND-ONLY. There is no edit path and no delete path in this module, because a support thread is
 * the evidence of what the platform told a user.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { applyContactPolicy } from '@/lib/messaging/contact-gate';
import type { SupportMessageDto } from '@/lib/types/support';
import {
  supportMessageLimitReachedError,
  supportStatusConflictError,
  supportTicketClosedError,
} from './errors';
import { applyTransition, endAwaitingUser, loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { emitSupportNotification } from './notifications';
import { MAX_SUPPORT_MESSAGES } from './limits';
import { toSupportMessageDto, type SupportMessageRow } from './rows';
import { isLiveSupportStatus } from './transitions';
import type { ParsedSupportMessage } from './validation';

const MESSAGE_COLUMNS = 'id, sender_user_id, body, is_admin, created_at';

async function assertRoom(ticketId: string): Promise<void> {
  const [row] = await queryRows<{ count: number }>(
    getDb(),
    sql`SELECT count(*)::int AS count FROM support_messages WHERE support_ticket_id = ${ticketId}`,
  );
  if ((row?.count ?? 0) >= MAX_SUPPORT_MESSAGES) throw supportMessageLimitReachedError();
}

async function findReplay(
  senderUserId: string,
  key: string,
  viewerUserId: string,
): Promise<{ message: SupportMessageDto; replayed: true } | null> {
  const [row] = await queryRows<SupportMessageRow>(
    getDb(),
    sql`SELECT ${sql.raw(MESSAGE_COLUMNS)} FROM support_messages
         WHERE sender_user_id = ${senderUserId} AND idempotency_key = ${key}`,
  );
  return row ? { message: toSupportMessageDto(row, viewerUserId), replayed: true } : null;
}

/**
 * The REQUESTER posts.
 *
 * Posting while `awaiting_user` ALSO performs `awaiting_user -> assigned` in the same call, because
 * the reply *is* the response the admin asked for — making the user press a second button to say
 * "I have answered" would be busywork that only ever produces stale queues. That transition is what
 * ends the SLA pause and pushes the deadline forward by exactly the time they took (AC-8).
 *
 * Notifies NOBODY. The queue is the admin's surface; a push per user message is noise.
 */
export async function postRequesterMessage(
  ticketId: string,
  userId: string,
  input: ParsedSupportMessage,
  idempotency: { key: string; fingerprint: string },
): Promise<{ message: SupportMessageDto; replayed: boolean }> {
  const replay = await findReplay(userId, idempotency.key, userId);
  if (replay) return replay;

  const ticket = await loadTicketRow(ticketId);
  if (!isLiveSupportStatus(ticket.status)) throw supportTicketClosedError();
  await assertRoom(ticketId);

  const policy = applyContactPolicy(input.body, true);

  const [row] = await queryRows<SupportMessageRow>(
    getDb(),
    sql`INSERT INTO support_messages
          (support_ticket_id, sender_user_id, body, is_admin, idempotency_key, idempotency_fingerprint)
        VALUES (${ticketId}, ${userId}, ${policy.body}, false, ${idempotency.key}, ${idempotency.fingerprint})
        RETURNING ${sql.raw(MESSAGE_COLUMNS)}`,
  );

  if (ticket.status === 'awaiting_user') {
    // Best-effort: if an admin moved the ticket in the same instant, their move stands and the
    // message is still recorded. A lost race here must never discard what the user wrote.
    try {
      await applyTransition(ticketId, 'awaiting_user', 'assigned', { extraSet: [endAwaitingUser()] });
    } catch {
      /* the admin's concurrent transition won; the message is saved either way */
    }
  }

  return { message: toSupportMessageDto(row!, userId), replayed: false };
}

/**
 * An ADMIN replies.
 *
 * `requestsInformation` performs `assigned -> awaiting_user`, which STARTS the SLA pause — the
 * clock stops while the platform is waiting on the user, so their delay cannot breach their own
 * ticket.
 *
 * Notifies the requester, content-free.
 */
export async function postAdminMessage(
  ticketId: string,
  adminUserId: string,
  input: ParsedSupportMessage,
  idempotency: { key: string; fingerprint: string },
  correlationId: string | null,
): Promise<{ message: SupportMessageDto; replayed: boolean }> {
  const replay = await findReplay(adminUserId, idempotency.key, adminUserId);
  if (replay) return replay;

  const ticket = await loadTicketRow(ticketId);
  if (!isLiveSupportStatus(ticket.status)) throw supportTicketClosedError();
  await assertRoom(ticketId);

  const policy = applyContactPolicy(input.body, true);

  const [row] = await queryRows<SupportMessageRow>(
    getDb(),
    sql`INSERT INTO support_messages
          (support_ticket_id, sender_user_id, body, is_admin, idempotency_key, idempotency_fingerprint)
        VALUES (${ticketId}, ${adminUserId}, ${policy.body}, true, ${idempotency.key}, ${idempotency.fingerprint})
        RETURNING ${sql.raw(MESSAGE_COLUMNS)}`,
  );

  let requestedInformation = false;
  if (input.requestsInformation) {
    if (ticket.status !== 'assigned') throw supportStatusConflictError(ticket.status);
    await applyTransition(ticketId, 'assigned', 'awaiting_user', { extraSet: [sql`awaiting_user_since = clock_timestamp()`] });
    requestedInformation = true;
  }

  await auditSupport({
    adminUserId,
    eventType: SUPPORT_EVENT_TYPES.adminReplied,
    targetId: ticketId,
    correlationId,
    details: { messageId: row!.id, requestsInformation: requestedInformation },
  });

  await emitSupportNotification(
    requestedInformation
      ? {
          kind: 'support_info_requested',
          ticketId,
          recipientUserId: ticket.requester_user_id,
          messageId: row!.id,
        }
      : {
          kind: 'support_reply_posted',
          ticketId,
          recipientUserId: ticket.requester_user_id,
          messageId: row!.id,
        },
  );

  return { message: toSupportMessageDto(row!, adminUserId), replayed: false };
}
