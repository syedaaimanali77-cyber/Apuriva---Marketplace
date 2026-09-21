/**
 * Spec 034 §3.2, §3.3, §4 "Deletion" — normal conversations: start, list, search, read, delete,
 * clear history. Every read and write is scoped to the caller's own `user_id`; a missing, deleted or
 * not-owned conversation is the same `404`.
 *
 * DELETION TOMBSTONES. Every baseline FK is `restrict`, and `ai_actions` keeps referencing a deleted
 * conversation so activity history survives (§85 is separate from §82). So deleting hard-deletes the
 * conversation's `ai_messages` (nothing references them) and then sets `deleted_at`. AI memory is
 * never touched by any of this (§3.9).
 *
 * Temporary conversations never reach this module: they are never stored (§3.11).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import { validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { aiConversations, aiMessages } from '@/lib/db/schema';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { AiConversationDto, AiConversationSummaryDto, AiMessageDto, AiMessageRole } from '@/lib/types/ai-assistant';
import { aiNotFoundError, idempotencyKeyConflictError, isUuid } from './errors';
import { requireAskApurivaAvailable } from './feature-flags';
import { AI_CONVERSATION_PREVIEW_LENGTH, AI_SEARCH_QUERY_MAX_LENGTH } from './limits';

type Paged<T> = { data: T[]; page: ReturnType<typeof buildPage> };

interface ConversationRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

function toConversationDto(row: ConversationRow): AiConversationDto {
  return { id: row.id, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The caller's own non-deleted conversation, optionally row-locked. Anything else — a malformed id,
 * another user's conversation, a tombstone — is `404`.
 */
export async function loadOwnedConversation(
  db: Executor,
  userId: string,
  conversationId: string,
  options?: { forUpdate?: boolean },
): Promise<ConversationRow> {
  if (!isUuid(conversationId)) throw aiNotFoundError();
  const [row] = await queryRows<{ id: string; created_at: Date; updated_at: Date }>(
    db,
    sql`SELECT id, created_at, updated_at FROM ai_conversations
         WHERE id = ${conversationId} AND user_id = ${userId} AND deleted_at IS NULL
         ${options?.forUpdate ? sql`FOR UPDATE` : sql``}`,
  );
  if (!row) throw aiNotFoundError();
  return { id: row.id, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at) };
}

/**
 * `POST /api/v1/ai/conversations` — starts an EMPTY normal conversation. `Idempotency-Key` is stored
 * on the row, unique per user: a replay with the same body returns the original with `200`, a
 * different body is `409` and writes nothing.
 */
export async function createConversation(
  userId: string,
  idempotencyKey: string,
  rawBody: unknown,
): Promise<{ conversation: AiConversationDto; replayed: boolean }> {
  requireAskApurivaAvailable();

  const body = rawBody ?? {};
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length > 0) {
    throw validationError([{ field: 'body', message: 'must be empty' }]);
  }
  const fingerprint = idempotencyFingerprint({});

  const existing = await findConversationByKey(userId, idempotencyKey);
  if (existing) return replayOrConflict(existing, fingerprint);

  try {
    const [row] = await getDb()
      .insert(aiConversations)
      .values({ userId, idempotencyKey, idempotencyFingerprint: fingerprint })
      .returning({ id: aiConversations.id, createdAt: aiConversations.createdAt, updatedAt: aiConversations.updatedAt });
    return { conversation: toConversationDto(row!), replayed: false };
  } catch (err) {
    if (!isUniqueViolation(err, 'ai_conversations_user_idempotency_key_uq')) throw err;
    const raced = await findConversationByKey(userId, idempotencyKey);
    if (!raced) throw err;
    return replayOrConflict(raced, fingerprint);
  }
}

async function findConversationByKey(userId: string, idempotencyKey: string) {
  const [row] = await getDb()
    .select({
      id: aiConversations.id,
      createdAt: aiConversations.createdAt,
      updatedAt: aiConversations.updatedAt,
      fingerprint: aiConversations.idempotencyFingerprint,
    })
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), eq(aiConversations.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

function replayOrConflict(
  row: ConversationRow & { fingerprint: string },
  fingerprint: string,
): { conversation: AiConversationDto; replayed: boolean } {
  if (row.fingerprint !== fingerprint) throw idempotencyKeyConflictError();
  return { conversation: toConversationDto(row), replayed: true };
}

/** Escapes `%`, `_` and `\` so `q` is matched literally by `ILIKE`. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `GET /api/v1/ai/conversations[?q=]` — the caller's own non-deleted conversations, most recently
 * updated first. With `q`, only those holding at least one message whose body contains `q`,
 * case-insensitively (§3.3 "Search"). `preview` is derived here and never stored.
 */
export async function listConversations(
  userId: string,
  searchParams: URLSearchParams,
  page: PageParams,
): Promise<Paged<AiConversationSummaryDto>> {
  const rawQ = searchParams.get('q');
  let q: string | null = null;
  if (rawQ !== null) {
    if (rawQ.length > AI_SEARCH_QUERY_MAX_LENGTH) {
      throw validationError([{ field: 'q', message: `must be at most ${AI_SEARCH_QUERY_MAX_LENGTH} characters` }]);
    }
    q = rawQ.trim().length > 0 ? rawQ : null;
  }

  const match = q === null
    ? sql``
    : sql`AND EXISTS (SELECT 1 FROM ai_messages m
                       WHERE m.ai_conversation_id = c.id AND m.body ILIKE ${likePattern(q)} ESCAPE '\\')`;

  const db = getDb();
  const [{ total }] = (await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM ai_conversations c WHERE c.user_id = ${userId} AND c.deleted_at IS NULL ${match}`,
  )) as [{ total: number }];

  const rows = await queryRows<{ id: string; created_at: Date; updated_at: Date; preview: string | null }>(
    db,
    sql`SELECT c.id, c.created_at, c.updated_at,
               (SELECT left(m.body, ${AI_CONVERSATION_PREVIEW_LENGTH}) FROM ai_messages m
                 WHERE m.ai_conversation_id = c.id AND m.role = 'user'
                 ORDER BY m.created_at ASC, m.id ASC LIMIT 1) AS preview
          FROM ai_conversations c
         WHERE c.user_id = ${userId} AND c.deleted_at IS NULL ${match}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return {
    data: rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      preview: r.preview ?? '',
    })),
    page: buildPage(total, page.limit, page.offset),
  };
}

export interface StoredMessage {
  id: string;
  role: AiMessageRole;
  body: string;
  createdAt: Date;
}

export function toMessageDto(row: StoredMessage): AiMessageDto {
  return { id: row.id, role: row.role, body: row.body, createdAt: row.createdAt.toISOString() };
}

/** Every stored turn of a conversation, in the one stable order: `created_at ASC, id ASC`. */
export async function transcriptOf(db: Executor, conversationId: string): Promise<StoredMessage[]> {
  const rows = await queryRows<{ id: string; role: AiMessageRole; body: string; created_at: Date }>(
    db,
    sql`SELECT id, role, body, created_at FROM ai_messages
         WHERE ai_conversation_id = ${conversationId}
         ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((r) => ({ id: r.id, role: r.role, body: r.body, createdAt: new Date(r.created_at) }));
}

/** `GET /api/v1/ai/conversations/{id}/messages` — the transcript page, `created_at ASC, id ASC`. */
export async function listTranscript(userId: string, conversationId: string, page: PageParams): Promise<Paged<AiMessageDto>> {
  const db = getDb();
  await loadOwnedConversation(db, userId, conversationId);

  const [{ total }] = (await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM ai_messages WHERE ai_conversation_id = ${conversationId}`,
  )) as [{ total: number }];
  const rows = await getDb()
    .select({ id: aiMessages.id, role: aiMessages.role, body: aiMessages.body, createdAt: aiMessages.createdAt })
    .from(aiMessages)
    .where(eq(aiMessages.aiConversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    .limit(page.limit)
    .offset(page.offset);

  return { data: rows.map(toMessageDto), page: buildPage(total, page.limit, page.offset) };
}

/** Hard-deletes a conversation's messages and tombstones it. Its `ai_actions` rows remain. */
async function tombstone(db: Executor, conversationId: string): Promise<void> {
  await db.execute(sql`DELETE FROM ai_messages WHERE ai_conversation_id = ${conversationId}`);
  await db.execute(sql`
    UPDATE ai_conversations
       SET deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${conversationId} AND deleted_at IS NULL
  `);
}

/** `DELETE /api/v1/ai/conversations/{id}` (AC-8). */
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await loadOwnedConversation(tx, userId, conversationId, { forUpdate: true });
    await tombstone(tx, conversationId);
  });
}

/** `DELETE /api/v1/ai/conversations` — clear history: every conversation the caller owns (AC-8). */
export async function clearHistory(userId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const rows = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM ai_conversations WHERE user_id = ${userId} AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
    );
    for (const { id } of rows) await tombstone(tx, id);
  });
}
