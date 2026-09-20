/**
 * Spec 031 §3 "Dispute messages" (DECIDED-7) — the dispute thread.
 *
 * WHY THIS IS NOT SPEC 025's `conversations`, restated where the code lives. Three concrete
 * differences, any one of which would be a breaking change to spec 025:
 *
 *   1. ADMIN VISIBILITY IS THE DEFAULT HERE AND A JUSTIFIED EXCEPTION THERE. Spec 025 gates admin
 *      conversation reads behind `messaging/read_conversation` AND a 10–500 character justification
 *      query parameter, precisely because reading a private conversation is intrusive. A dispute
 *      message is written TO BE READ by the deciding admin — that is its purpose. Putting it in a
 *      `conversations` row would either weaken spec 025's justification rule for everyone or force
 *      a per-conversation exception into its access resolver.
 *   2. RETENTION DIFFERS. `app/api/v1/cron/message-retention-sweep` deletes old messages; dispute
 *      messages are evidence in a financial decision and are retained with the dispute under the
 *      same legal-hold rule as evidence.
 *   3. LIFECYCLE DIFFERS. A conversation is tied to a booking and archives with it; dispute
 *      messages open with the dispute and freeze when it closes.
 *
 * WHAT IS REUSED RATHER THAN REBUILT: spec 025's `MESSAGE_BODY_MAX_LENGTH` as the body bound, and
 * `applyContactPolicy()` for contact-information handling. Because a dispute only exists on a
 * `protected` booking — long past `confirmed` — spec 025's own rule puts this unambiguously in the
 * FLAG, NEVER MASK branch: the body is stored verbatim and `contact_flagged` is set as a Trust &
 * Safety signal. Redacting evidence would be wrong. No second detector, no second bound, no second
 * sanitizer.
 *
 * APPEND-ONLY. There is no edit path and no delete path, because a dispute message is a statement
 * made in a proceeding.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import { applyContactPolicy } from '@/lib/messaging/contact-gate';
import type { PageParams } from '@/lib/api/pagination';
import type { DisputeMessageDto } from '@/lib/types/disputes';
import { disputeMessageLimitReachedError, disputeNotOpenError } from './errors';
import { MAX_DISPUTE_MESSAGES } from './limits';
import {
  auditDispute,
  DISPUTE_EVENT_TYPES,
  resolveAdminAccess,
  resolveParticipantAccess,
  type DisputeOwnership,
} from './read';
import { requireDisputeReadPermission, requireDisputeResolvePermission } from './permissions';
import { isContributable } from './transitions';
import { toMessageDto, type MessageRow } from './rows';
import type { ParsedDisputeMessage } from './validation';

const MESSAGE_COLUMNS = 'id, sender_user_id, body, is_admin, created_at';

async function countMessages(disputeId: string): Promise<number> {
  const [row] = await queryRows<{ total: number }>(
    getDb(),
    sql`SELECT COUNT(*)::int AS total FROM dispute_messages WHERE dispute_id = ${disputeId}`,
  );
  return row?.total ?? 0;
}

async function insertMessage(
  disputeId: string,
  senderUserId: string,
  body: string,
  isAdmin: boolean,
  contactFlagged: boolean,
  idempotency: { key: string; fingerprint: string },
): Promise<MessageRow> {
  const [row] = await queryRows<MessageRow>(
    getDb(),
    sql`INSERT INTO dispute_messages
          (dispute_id, sender_user_id, body, is_admin, contact_flagged, idempotency_key, idempotency_fingerprint)
        VALUES (${disputeId}, ${senderUserId}, ${body}, ${isAdmin}, ${contactFlagged},
                ${idempotency.key}, ${idempotency.fingerprint})
        RETURNING ${sql.raw(MESSAGE_COLUMNS)}`,
  );
  return row!;
}

async function replayMessage(senderUserId: string, key: string): Promise<MessageRow | null> {
  const [row] = await queryRows<MessageRow>(
    getDb(),
    sql`SELECT ${sql.raw(MESSAGE_COLUMNS)} FROM dispute_messages
         WHERE sender_user_id = ${senderUserId} AND idempotency_key = ${key}`,
  );
  return row ?? null;
}

/** A participant posts. Allowed while `open`, `under_review` or `appealed` — never once decided. */
export async function postParticipantMessage(
  disputeId: string,
  userId: string,
  input: ParsedDisputeMessage,
  idempotency: { key: string; fingerprint: string },
): Promise<{ message: DisputeMessageDto; replayed: boolean }> {
  const ownership = await resolveParticipantAccess(disputeId, userId);
  const replay = await replayMessage(userId, idempotency.key);
  if (replay) return { message: toMessageDto(replay, userId), replayed: true };

  if (!isContributable(ownership.status)) throw disputeNotOpenError(ownership.status);
  if ((await countMessages(disputeId)) >= MAX_DISPUTE_MESSAGES) throw disputeMessageLimitReachedError(MAX_DISPUTE_MESSAGES);

  // `contactSharingAllowed = true` — the FLAG branch. A dispute is always post-`confirmed`, so spec
  // 025's own rule keeps the body verbatim and raises a signal rather than redacting evidence.
  const policy = applyContactPolicy(input.body, true);

  try {
    const row = await insertMessage(disputeId, userId, policy.body, false, policy.contactFlagged, idempotency);
    return { message: toMessageDto(row, userId), replayed: false };
  } catch (err) {
    if (isUniqueViolation(err, 'dispute_messages_sender_idempotency_uq')) {
      const existing = await replayMessage(userId, idempotency.key);
      if (existing) return { message: toMessageDto(existing, userId), replayed: true };
    }
    throw err;
  }
}

/**
 * An admin posts, flagged `is_admin` so the parties can see an official message is official.
 *
 * Requires `disputes/resolve`, not merely `disputes/read`: speaking into a live dispute is an act,
 * not an observation. It is audited; participant posts are not, because auditing every user
 * utterance would drown spec 009's `security_events` in ordinary application data.
 */
export async function postAdminMessage(
  disputeId: string,
  adminUserId: string,
  input: ParsedDisputeMessage,
  idempotency: { key: string; fingerprint: string },
  correlationId: string | null,
): Promise<{ message: DisputeMessageDto; replayed: boolean }> {
  const ownership = await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);
  const replay = await replayMessage(adminUserId, idempotency.key);
  if (replay) return { message: toMessageDto(replay, adminUserId), replayed: true };

  if (!isContributable(ownership.status)) throw disputeNotOpenError(ownership.status);
  if ((await countMessages(disputeId)) >= MAX_DISPUTE_MESSAGES) throw disputeMessageLimitReachedError(MAX_DISPUTE_MESSAGES);

  const policy = applyContactPolicy(input.body, true);
  const row = await insertMessage(disputeId, adminUserId, policy.body, true, policy.contactFlagged, idempotency);

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.adminMessagePosted,
    targetId: disputeId,
    correlationId,
    details: { messageId: row.id },
  });

  return { message: toMessageDto(row, adminUserId), replayed: false };
}

async function pageMessages(disputeId: string, page: PageParams): Promise<{ rows: MessageRow[]; total: number }> {
  const db = getDb();
  const rows = await queryRows<MessageRow>(
    db,
    // Oldest first: the thread reads as a record of an argument, not as a chat feed.
    sql`SELECT ${sql.raw(MESSAGE_COLUMNS)} FROM dispute_messages
         WHERE dispute_id = ${disputeId}
         ORDER BY created_at ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: number }>(
    db,
    sql`SELECT COUNT(*)::int AS total FROM dispute_messages WHERE dispute_id = ${disputeId}`,
  );
  return { rows, total: count?.total ?? 0 };
}

/**
 * A participant reads the WHOLE thread — their own messages, the counterparty's, and any admin's.
 *
 * No read receipts and no unread counts: those are spec 025's conversation features and are
 * deliberately not reproduced here.
 */
export async function listMessagesForParticipant(
  disputeId: string,
  userId: string,
  page: PageParams,
): Promise<{ items: DisputeMessageDto[]; total: number }> {
  await resolveParticipantAccess(disputeId, userId);
  const { rows, total } = await pageMessages(disputeId, page);
  return { items: rows.map((row) => toMessageDto(row, userId)), total };
}

/** An admin reads the thread. Audited — who read a given dispute's messages is a recorded fact. */
export async function listMessagesForAdmin(
  disputeId: string,
  adminUserId: string,
  page: PageParams,
  correlationId: string | null,
): Promise<{ items: DisputeMessageDto[]; total: number }> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeReadPermission);
  const { rows, total } = await pageMessages(disputeId, page);

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.messagesRead,
    targetId: disputeId,
    correlationId,
    details: { returned: rows.length },
  });

  return { items: rows.map((row) => toMessageDto(row, adminUserId)), total };
}

export type { DisputeOwnership };
