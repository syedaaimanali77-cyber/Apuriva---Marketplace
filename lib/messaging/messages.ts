/**
 * Spec 025 §3 "Messaging behaviour" — send (AC-1, AC-2, AC-6, AC-8), paged and delta reads (AC-1, AC-3)
 * and the monotonic read marker.
 *
 * Lock order on send: `bookings` FOR SHARE, then `conversations` FOR UPDATE. The share lock conflicts
 * with every booking transition's row update, so no message commits against a status it did not see;
 * the conversation lock serializes sends per conversation, which is what makes `created_at` strictly
 * increasing and the `after` cursor exact (§3 "Ordering").
 */
import { sql } from 'drizzle-orm';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { SessionRow } from '@/lib/auth/session';
import type { ConversationParticipantRole, ConversationReadStateDto, MessageDto } from '@/lib/types/messaging';
import { checkConversationBlock } from './block-gate';
import { applyContactPolicy } from './contact-gate';
import {
  bookingStatusOf,
  ensureConversation,
  openConversation,
  resolveConversationAccess,
  unreadCountSql,
} from './conversations';
import { parseMessageCursor } from './cursor';
import {
  blockedError,
  conversationArchivedError,
  idempotencyKeyConflictError,
  messageNotInConversationError,
} from './errors';
import { isArchivedBookingStatus, isContactSharingAllowed } from './lifecycle';
import { MESSAGE_BODY_MAX_LENGTH, STORED_BODY_MAX_LENGTH } from './limits';
import { emitMessagingNotification } from './notifications';

type Session = Pick<SessionRow, 'userId' | 'activeMode'>;
export type PagedMessages = { data: MessageDto[]; page: ReturnType<typeof buildPage> };

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_role: ConversationParticipantRole;
  body: string;
  contact_redacted: boolean;
  contact_flagged: boolean;
  redacted_by_retention: boolean;
  created_at: Date;
  read_by_counterparty_at: Date | null;
}

/** Never selects idempotency keys or fingerprints. */
const MESSAGE_SELECT = sql`
  SELECT m.id, m.conversation_id, m.sender_user_id, m.sender_role, m.body, m.contact_redacted,
         m.contact_flagged, m.redacted_by_retention, m.created_at,
         CASE WHEN other.last_read_at >= m.created_at THEN other.last_read_at END AS read_by_counterparty_at
    FROM messages m
    LEFT JOIN conversation_participants other
      ON other.conversation_id = m.conversation_id AND other.role <> m.sender_role
`;

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderUserId: row.sender_user_id,
    senderRole: row.sender_role,
    body: row.body,
    contactRedacted: row.contact_redacted,
    contactFlagged: row.contact_flagged,
    readByCounterpartyAt: row.read_by_counterparty_at ? new Date(row.read_by_counterparty_at).toISOString() : null,
    redactedByRetention: row.redacted_by_retention,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function loadMessageDto(db: Executor, messageId: string): Promise<MessageDto> {
  const [row] = await queryRows<MessageRow>(db, sql`${MESSAGE_SELECT} WHERE m.id = ${messageId}`);
  return toMessageDto(row!);
}

/** Trimmed 1–2000 characters, measured on the INPUT before redaction. Pure. */
export function validateSendBody(raw: unknown): string {
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).body : undefined;
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (typeof body !== 'string' || trimmed.length === 0 || trimmed.length > MESSAGE_BODY_MAX_LENGTH) {
    throw validationError([{ field: 'body', message: `must be 1-${MESSAGE_BODY_MAX_LENGTH} characters` }]);
  }
  return trimmed;
}

type IdempotencyHit = { kind: 'replay'; messageId: string } | { kind: 'conflict' } | null;

async function findByIdempotencyKey(db: Executor, senderUserId: string, key: string, fingerprint: string): Promise<IdempotencyHit> {
  const [row] = await queryRows<{ id: string; idempotency_fingerprint: string }>(
    db,
    sql`SELECT id, idempotency_fingerprint FROM messages WHERE sender_user_id = ${senderUserId} AND idempotency_key = ${key}`,
  );
  if (!row) return null;
  return row.idempotency_fingerprint === fingerprint ? { kind: 'replay', messageId: row.id } : { kind: 'conflict' };
}

async function logContactFlag(args: {
  conversationId: string;
  bookingId: string;
  senderUserId: string;
  mode: 'masked' | 'flagged';
}): Promise<void> {
  const [row] = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM messages
         WHERE sender_user_id = ${args.senderUserId} AND (contact_redacted OR contact_flagged)
           AND created_at > clock_timestamp() - interval '24 hours'`,
  );
  console.log(JSON.stringify({ event: 'messaging.contact_flagged', ...args, count24h: row?.n ?? 0 }));
}

/** `POST /api/v1/bookings/{id}/conversation/messages`. A replay returns the original with `replayed: true`. */
export async function sendMessage(
  session: Session,
  bookingId: string,
  idempotencyKey: string,
  rawBody: unknown,
): Promise<{ message: MessageDto; replayed: boolean }> {
  const access = await resolveConversationAccess(session, bookingId);
  const input = validateSendBody(rawBody);

  const fingerprint = idempotencyFingerprint({ bookingId, body: rawBody });
  const early = await findByIdempotencyKey(getDb(), access.userId, idempotencyKey, fingerprint);
  if (early?.kind === 'conflict') throw idempotencyKeyConflictError();
  if (early?.kind === 'replay') return { message: await loadMessageDto(getDb(), early.messageId), replayed: true };

  let outcome: {
    messageId: string;
    replayed: boolean;
    conversationId: string;
    contactRedacted: boolean;
    contactFlagged: boolean;
  };
  try {
    outcome = await getDb().transaction(async (tx) => {
      const bookingStatus = await bookingStatusOf(tx, bookingId, 'share');
      const conversationId = await ensureConversation(tx, access, bookingStatus);
      await tx.execute(sql`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`);

      const locked = await findByIdempotencyKey(tx, access.userId, idempotencyKey, fingerprint);
      if (locked?.kind === 'conflict') throw idempotencyKeyConflictError();
      if (locked?.kind === 'replay') {
        return { messageId: locked.messageId, replayed: true, conversationId, contactRedacted: false, contactFlagged: false };
      }

      if (isArchivedBookingStatus(bookingStatus)) throw conversationArchivedError();

      const block = await checkConversationBlock(tx, access.userId, access.counterpartyUserId, conversationId);
      if (block.blocked) {
        console.log(JSON.stringify({ event: 'messaging.blocked_send_rejected', conversationId, reason: block.reason ?? null }));
        throw blockedError();
      }

      const policy = applyContactPolicy(input, isContactSharingAllowed(bookingStatus));
      const stored = policy.body.length > STORED_BODY_MAX_LENGTH ? policy.body.slice(0, STORED_BODY_MAX_LENGTH) : policy.body;

      // created_at: millisecond precision, strictly greater than the conversation's previous message.
      const [inserted] = await queryRows<{ id: string; created_at: Date }>(
        tx,
        sql`WITH ts AS (
              SELECT GREATEST(date_trunc('milliseconds', clock_timestamp()),
                              COALESCE(last_message_at + interval '1 millisecond', '-infinity'::timestamptz)) AS at
                FROM conversations WHERE id = ${conversationId}
            )
            INSERT INTO messages (conversation_id, sender_user_id, sender_role, body, contact_redacted, contact_flagged,
                                  idempotency_key, idempotency_fingerprint, created_at, updated_at)
            SELECT ${conversationId}, ${access.userId}, ${access.role}, ${stored}, ${policy.contactRedacted},
                   ${policy.contactFlagged}, ${idempotencyKey}, ${fingerprint}, ts.at, ts.at
              FROM ts
            RETURNING id, created_at`,
      );
      await tx.execute(sql`
        UPDATE conversations
           SET last_message_at = (SELECT created_at FROM messages WHERE id = ${inserted!.id}),
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${conversationId}
      `);
      return {
        messageId: inserted!.id,
        replayed: false,
        conversationId,
        contactRedacted: policy.contactRedacted,
        contactFlagged: policy.contactFlagged,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'messages_sender_idempotency_key_uq')) {
      const hit = await findByIdempotencyKey(getDb(), access.userId, idempotencyKey, fingerprint);
      if (hit?.kind === 'replay') return { message: await loadMessageDto(getDb(), hit.messageId), replayed: true };
      throw idempotencyKeyConflictError();
    }
    throw err;
  }

  if (!outcome.replayed) {
    console.log(
      JSON.stringify({
        event: 'messaging.message_sent',
        conversationId: outcome.conversationId,
        bookingId,
        senderRole: access.role,
        contactRedacted: outcome.contactRedacted,
        contactFlagged: outcome.contactFlagged,
      }),
    );
    if (outcome.contactRedacted || outcome.contactFlagged) {
      await logContactFlag({
        conversationId: outcome.conversationId,
        bookingId,
        senderUserId: access.userId,
        mode: outcome.contactRedacted ? 'masked' : 'flagged',
      });
    }
    await emitMessagingNotification({
      kind: 'message_received',
      conversationId: outcome.conversationId,
      bookingId,
      messageId: outcome.messageId,
      recipientUserId: access.counterpartyUserId,
    });
  }
  return { message: await loadMessageDto(getDb(), outcome.messageId), replayed: outcome.replayed };
}

/**
 * The single total order `created_at ASC, id ASC`, used by every read. `after` is the delta read the
 * poller uses; combining it with `offset` is a validation error.
 */
export async function listConversationMessages(db: Executor, conversationId: string, searchParams: URLSearchParams): Promise<PagedMessages> {
  const rawAfter = searchParams.get('after');
  if (rawAfter !== null && searchParams.has('offset')) {
    throw validationError([{ field: 'after', message: 'cannot be combined with offset' }]);
  }

  if (rawAfter !== null) {
    const cursor = parseMessageCursor(rawAfter);
    const { limit } = parsePageParams(searchParams);
    const after = sql`(m.created_at, m.id) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
    const [{ total } = { total: 0 }] = await queryRows<{ total: number }>(
      db,
      sql`SELECT count(*)::int AS total FROM messages m WHERE m.conversation_id = ${conversationId} AND ${after}`,
    );
    const rows = await queryRows<MessageRow>(
      db,
      sql`${MESSAGE_SELECT} WHERE m.conversation_id = ${conversationId} AND ${after}
           ORDER BY m.created_at ASC, m.id ASC LIMIT ${limit}`,
    );
    return { data: rows.map(toMessageDto), page: buildPage(Number(total), limit, 0) };
  }

  const page = parsePageParams(searchParams);
  const [{ total } = { total: 0 }] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM messages WHERE conversation_id = ${conversationId}`,
  );
  const rows = await queryRows<MessageRow>(
    db,
    sql`${MESSAGE_SELECT} WHERE m.conversation_id = ${conversationId}
         ORDER BY m.created_at ASC, m.id ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  return { data: rows.map(toMessageDto), page: buildPage(Number(total), page.limit, page.offset) };
}

const RESUMED_PATTERN = /^(\d{1,4}):(\d{1,7})$/;

/**
 * §9 "Observability" for the polling transport. Both are derived from the delta read itself, the one place
 * the server sees delivery happen, and carry identifiers and numbers only — never a body.
 *
 *   - `messaging.delivery_latency_ms`: for each COUNTERPARTY message a delta read returns, server
 *     `created_at` → now. A cursor read returns a message to a poller once, so this is first delivery.
 *   - `messaging.poll_recovered`: the client appends `resumed=<failedAttempts>:<gapSeconds>` to its first
 *     successful delta read after failed polls. Telemetry only: it never changes the read, and a malformed
 *     value is ignored rather than failing a user's message fetch.
 */
function logDeltaObservability(conversationId: string, viewerUserId: string, searchParams: URLSearchParams, result: PagedMessages): void {
  const now = Date.now();
  for (const message of result.data) {
    if (message.senderUserId === viewerUserId) continue;
    console.log(
      JSON.stringify({ event: 'messaging.delivery_latency_ms', conversationId, latencyMs: Math.max(0, now - Date.parse(message.createdAt)) }),
    );
  }
  const resumed = RESUMED_PATTERN.exec(searchParams.get('resumed') ?? '');
  if (resumed) {
    console.log(
      JSON.stringify({ event: 'messaging.poll_recovered', conversationId, failedAttempts: Number(resumed[1]), gapSeconds: Number(resumed[2]) }),
    );
  }
}

/** `GET /api/v1/bookings/{id}/conversation/messages` — readable in every status, blocked or not. */
export async function listMessagesForParticipant(session: Session, bookingId: string, searchParams: URLSearchParams): Promise<PagedMessages> {
  const access = await resolveConversationAccess(session, bookingId);
  // Validate the query before any write, so a malformed request never creates a conversation.
  if (searchParams.get('after') !== null) parseMessageCursor(searchParams.get('after')!);
  const { conversationId } = await openConversation(access);
  const result = await listConversationMessages(getDb(), conversationId, searchParams);
  if (searchParams.get('after') !== null) logDeltaObservability(conversationId, access.userId, searchParams, result);
  return result;
}

/** `POST /api/v1/bookings/{id}/conversation/read` — advances `last_read_at` monotonically. */
export async function markConversationRead(session: Session, bookingId: string, rawBody: unknown): Promise<ConversationReadStateDto> {
  const access = await resolveConversationAccess(session, bookingId);
  const lastReadMessageId =
    typeof rawBody === 'object' && rawBody !== null ? (rawBody as Record<string, unknown>).lastReadMessageId : undefined;
  if (!isUuid(lastReadMessageId)) {
    throw validationError([{ field: 'lastReadMessageId', message: 'must be a message id' }]);
  }

  return getDb().transaction(async (tx) => {
    const bookingStatus = await bookingStatusOf(tx, bookingId);
    const conversationId = await ensureConversation(tx, access, bookingStatus);
    if (isArchivedBookingStatus(bookingStatus)) throw conversationArchivedError();

    const [message] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM messages WHERE id = ${lastReadMessageId} AND conversation_id = ${conversationId}`,
    );
    if (!message) throw messageNotInConversationError();

    const [updated] = await queryRows<{ last_read_at: Date }>(
      tx,
      sql`UPDATE conversation_participants
             SET last_read_at = GREATEST(COALESCE(last_read_at, '-infinity'::timestamptz),
                                         (SELECT created_at FROM messages WHERE id = ${lastReadMessageId})),
                 updated_at = clock_timestamp(), version = version + 1
           WHERE conversation_id = ${conversationId} AND user_id = ${access.userId}
         RETURNING last_read_at`,
    );
    const [{ unread } = { unread: 0 }] = await queryRows<{ unread: number }>(
      tx,
      sql`SELECT ${unreadCountSql(conversationId, access.userId)} AS unread`,
    );
    return {
      conversationId,
      lastReadAt: new Date(updated!.last_read_at).toISOString(),
      unreadCount: Number(unread),
    };
  });
}
