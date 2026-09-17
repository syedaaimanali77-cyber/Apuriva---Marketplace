/**
 * Spec 025 §3 "Conversation lifecycle" (AC-1, AC-3, AC-7) and participant authorization.
 *
 * A conversation is created LAZILY and idempotently on the first participant request that touches it,
 * inside that request's transaction. `conversations_booking_id_uq` and
 * `conversation_participants_conversation_role_uq` make concurrent first-touches converge on exactly one
 * conversation with exactly two participants — no application read-then-write check is relied on.
 *
 * Participants are resolved ONCE from the booking and frozen. `bookings.provider_profile_id` and
 * `customer_profile_id` are never updated by any spec, so they are permanently correct.
 */
import { sql } from 'drizzle-orm';
import { forbiddenError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { SessionRow } from '@/lib/auth/session';
import type { BookingStatus } from '@/lib/types/bookings';
import type { ConversationDto, ConversationParticipantDto, ConversationParticipantRole } from '@/lib/types/messaging';
import { conversationNotFoundError } from './errors';
import { isArchivedBookingStatus, isContactSharingAllowed } from './lifecycle';
import { ARCHIVED_BOOKING_STATUSES } from './limits';

/** Who the caller is on this booking — the basis of every participant authorization decision. */
export interface ConversationAccess {
  bookingId: string;
  userId: string;
  role: ConversationParticipantRole;
  counterpartyUserId: string;
  customerUserId: string;
  providerUserId: string;
}

interface BookingPartiesRow {
  booking_id: string;
  customer_user_id: string;
  provider_user_id: string;
}

/**
 * Resolves the caller's participation, or throws.
 *
 * A non-participant (or a malformed id, or a missing booking) is `404 CONVERSATION_NOT_FOUND` — never
 * `403` — so existence is not probeable. A participant in the WRONG active mode is `403 FORBIDDEN`: each
 * party may act only in their own mode, which also makes a user holding both profiles unambiguous.
 */
export async function resolveConversationAccess(
  session: Pick<SessionRow, 'userId' | 'activeMode'>,
  bookingId: string,
  tx?: Executor,
): Promise<ConversationAccess> {
  if (!isUuid(bookingId)) throw conversationNotFoundError();

  const [row] = await queryRows<BookingPartiesRow>(
    tx ?? getDb(),
    sql`SELECT b.id AS booking_id, cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId} AND (cp.user_id = ${session.userId} OR pp.user_id = ${session.userId})`,
  );
  if (!row) throw conversationNotFoundError();

  const mode = session.activeMode;
  if (mode === 'customer' && row.customer_user_id === session.userId) {
    return { bookingId, userId: session.userId, role: 'customer', counterpartyUserId: row.provider_user_id, customerUserId: row.customer_user_id, providerUserId: row.provider_user_id };
  }
  if (mode === 'provider' && row.provider_user_id === session.userId) {
    return { bookingId, userId: session.userId, role: 'provider', counterpartyUserId: row.customer_user_id, customerUserId: row.customer_user_id, providerUserId: row.provider_user_id };
  }
  throw forbiddenError('Switch to the mode you hold on this booking to use its conversation.');
}

export async function bookingStatusOf(db: Executor, bookingId: string, lock: 'share' | 'none' = 'none'): Promise<BookingStatus> {
  const [row] = await queryRows<{ status: BookingStatus }>(
    db,
    lock === 'share'
      ? sql`SELECT status FROM bookings WHERE id = ${bookingId} FOR SHARE`
      : sql`SELECT status FROM bookings WHERE id = ${bookingId}`,
  );
  if (!row) throw conversationNotFoundError();
  return row.status;
}

/**
 * Creates the conversation and both participant rows if absent, and stamps `archived_at` the first time
 * an archived booking status is observed. Idempotent and race-safe; returns the conversation id.
 */
export async function ensureConversation(tx: Executor, access: ConversationAccess, bookingStatus: BookingStatus): Promise<string> {
  await tx.execute(sql`
    INSERT INTO conversations (booking_id, created_at, updated_at)
    VALUES (${access.bookingId}, clock_timestamp(), clock_timestamp())
    ON CONFLICT (booking_id) WHERE booking_id IS NOT NULL DO NOTHING
  `);
  const [conversation] = await queryRows<{ id: string; archived_at: Date | null }>(
    tx,
    sql`SELECT id, archived_at FROM conversations WHERE booking_id = ${access.bookingId}`,
  );
  const conversationId = conversation!.id;

  await tx.execute(sql`
    INSERT INTO conversation_participants (conversation_id, user_id, role, created_at, updated_at)
    VALUES (${conversationId}, ${access.customerUserId}, 'customer', clock_timestamp(), clock_timestamp()),
           (${conversationId}, ${access.providerUserId}, 'provider', clock_timestamp(), clock_timestamp())
    ON CONFLICT DO NOTHING
  `);

  if (conversation!.archived_at === null && isArchivedBookingStatus(bookingStatus)) {
    await stampArchived(tx, conversationId);
  }
  return conversationId;
}

async function stampArchived(tx: Executor, conversationId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE conversations SET archived_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${conversationId} AND archived_at IS NULL
  `);
}

/** The archived-status list as SQL, for set-based statements (the retention sweep). */
export function archivedStatusesSql() {
  return sql.join(ARCHIVED_BOOKING_STATUSES.map((status) => sql`${status}`), sql`, `);
}

/** Opens the conversation for a participant in its own transaction and returns the ids. */
export async function openConversation(access: ConversationAccess): Promise<{ conversationId: string; bookingStatus: BookingStatus }> {
  return getDb().transaction(async (tx) => {
    const bookingStatus = await bookingStatusOf(tx, access.bookingId);
    const conversationId = await ensureConversation(tx, access, bookingStatus);
    return { conversationId, bookingStatus };
  });
}

interface ConversationRow {
  id: string;
  booking_id: string;
  archived_at: Date | null;
  last_message_at: Date | null;
  created_at: Date;
  message_count: number;
  unread_count: number;
}

interface ParticipantRow {
  user_id: string;
  role: ConversationParticipantRole;
  last_read_at: Date | null;
  business_name: string | null;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

export async function loadParticipants(db: Executor, conversationId: string): Promise<ConversationParticipantDto[]> {
  const rows = await queryRows<ParticipantRow>(
    db,
    sql`SELECT p.user_id, p.role, p.last_read_at, pp.business_name
          FROM conversation_participants p
          LEFT JOIN provider_profiles pp ON p.role = 'provider' AND pp.user_id = p.user_id
         WHERE p.conversation_id = ${conversationId}
         ORDER BY p.role ASC`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    displayName: row.role === 'provider' ? row.business_name : null,
    lastReadAt: iso(row.last_read_at),
  }));
}

/** Counts messages from the OTHER participant newer than `viewerUserId`'s `last_read_at`. */
export function unreadCountSql(conversationId: string, viewerUserId: string) {
  return sql`(SELECT count(*)::int FROM messages m
                JOIN conversation_participants me ON me.conversation_id = m.conversation_id AND me.user_id = ${viewerUserId}
               WHERE m.conversation_id = ${conversationId}
                 AND m.sender_user_id <> ${viewerUserId}
                 AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at))`;
}

export async function loadConversationDto(
  db: Executor,
  conversationId: string,
  viewerUserId: string,
  bookingStatus: BookingStatus,
): Promise<ConversationDto> {
  const [row] = await queryRows<ConversationRow>(
    db,
    sql`SELECT c.id, c.booking_id, c.archived_at, c.last_message_at, c.created_at,
               (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
               ${unreadCountSql(conversationId, viewerUserId)} AS unread_count
          FROM conversations c WHERE c.id = ${conversationId}`,
  );
  if (!row) throw conversationNotFoundError();
  return {
    id: row.id,
    bookingId: row.booking_id,
    participants: await loadParticipants(db, conversationId),
    isActive: !isArchivedBookingStatus(bookingStatus),
    archivedAt: iso(row.archived_at),
    contactSharingAllowed: isContactSharingAllowed(bookingStatus),
    messageCount: Number(row.message_count),
    lastMessageAt: iso(row.last_message_at),
    unreadCount: Number(row.unread_count),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** `GET /api/v1/bookings/{id}/conversation` — creates the conversation on first access. */
export async function getConversation(session: Pick<SessionRow, 'userId' | 'activeMode'>, bookingId: string): Promise<ConversationDto> {
  const access = await resolveConversationAccess(session, bookingId);
  const { conversationId, bookingStatus } = await openConversation(access);
  return loadConversationDto(getDb(), conversationId, access.userId, bookingStatus);
}
