/**
 * Spec 034 §3.9 — AI memory: view, explicit confirmation, delete, reset.
 *
 * PROPOSE, THEN CONFIRM. A turn may return a `memoryProposal`, which is stored nowhere. An entry is
 * written ONLY here, by the user's own `POST /api/v1/ai/memory` — a typed "yes" in a conversation
 * saves nothing (§3.5). The confirmation must name a non-deleted NORMAL conversation the caller owns;
 * a temporary conversation has no id, so it can never produce a memory write (AC-14).
 *
 * This is this spec's own write to its own table: not an MCP action, never passed to the executor,
 * no `ai_actions` row. Memory and conversation history are independent — deleting conversations
 * never touches memory and resetting memory never touches conversations (AC-8).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { aiConversations, aiMemories } from '@/lib/db/schema';
import { queryRows } from '@/lib/offers/db';
import type { AiMemoryEntry, AiMemoryItemDto } from '@/lib/types/ai-assistant';
import { aiNotFoundError, isUuid } from './errors';
import { requireAskApurivaAvailable } from './feature-flags';
import { summarizeMemoryValues, validateMemoryEntry } from './memory-keys';

interface MemoryRow {
  id: string;
  key: AiMemoryEntry['key'];
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
}

async function toDtos(rows: MemoryRow[]): Promise<AiMemoryItemDto[]> {
  const entries = rows.map((r) => ({ key: r.key, value: r.value }) as AiMemoryEntry);
  const summaries = await summarizeMemoryValues(entries);
  return rows.map((row, i) => ({
    ...entries[i]!,
    id: row.id,
    valueSummary: summaries[i]!,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function memoryRowsFor(userId: string): Promise<MemoryRow[]> {
  return getDb()
    .select({
      id: aiMemories.id,
      key: aiMemories.key,
      value: aiMemories.value,
      createdAt: aiMemories.createdAt,
      updatedAt: aiMemories.updatedAt,
    })
    .from(aiMemories)
    .where(eq(aiMemories.userId, userId))
    .orderBy(asc(aiMemories.createdAt), asc(aiMemories.id));
}

/** `GET /api/v1/ai/memory` — small by construction (at most one entry per allow-listed key). */
export async function listMemory(userId: string): Promise<AiMemoryItemDto[]> {
  return toDtos(await memoryRowsFor(userId));
}

/**
 * The memory context a turn — normal OR temporary — sends to the model as `{ key, valueSummary }`
 * (§3.3). Reading memory creates nothing, so a temporary conversation uses it like any other.
 */
export async function memoryContextFor(userId: string): Promise<Array<{ key: string; valueSummary: string }>> {
  const items = await listMemory(userId);
  return items.map((item) => ({ key: item.key, valueSummary: item.valueSummary }));
}

/**
 * `POST /api/v1/ai/memory` — the user's explicit confirmation of a proposed item (§3.9 steps 2–4).
 * Upserts on `(user_id, key)`: `created` when the key is new (`201`), otherwise the value is replaced
 * by the one just confirmed (`200`). Naturally idempotent, so it takes no `Idempotency-Key`.
 */
export async function confirmMemory(userId: string, rawBody: unknown): Promise<{ item: AiMemoryItemDto; created: boolean }> {
  requireAskApurivaAvailable();

  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
    throw validationError([{ field: 'body', message: 'must be an object' }]);
  }
  const body = rawBody as Record<string, unknown>;
  const extra = Object.keys(body).filter((field) => !['conversationId', 'key', 'value'].includes(field));
  if (extra.length > 0) throw validationError([{ field: 'body', message: `unexpected field(s): ${extra.join(', ')}` }]);
  if (typeof body.conversationId !== 'string' || body.conversationId.length === 0) {
    throw validationError([{ field: 'conversationId', message: 'is required' }]);
  }

  const validated = await validateMemoryEntry(body.key, body.value);
  if (!validated.ok) throw validationError(validated.errors);

  // Only a stored, non-deleted NORMAL conversation the caller owns can carry a proposal.
  if (!isUuid(body.conversationId)) throw aiNotFoundError();
  const [conversation] = await getDb()
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(
      and(eq(aiConversations.id, body.conversationId), eq(aiConversations.userId, userId), isNull(aiConversations.deletedAt)),
    );
  if (!conversation) throw aiNotFoundError();

  const { key, value } = validated.entry;
  const [row] = await queryRows<{ id: string; inserted: boolean }>(
    getDb(),
    sql`INSERT INTO ai_memories (user_id, key, value)
        VALUES (${userId}, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (user_id, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = clock_timestamp(), version = ai_memories.version + 1
        RETURNING id, (xmax = 0) AS inserted`,
  );

  // Counted without content: the key only, never the value (§9 "Observability").
  console.log(JSON.stringify({ event: 'ai_assistant.memory_confirmed', key }));

  const [stored] = (await memoryRowsFor(userId)).filter((r) => r.id === row!.id);
  const [item] = await toDtos([stored!]);
  return { item: item!, created: row!.inserted };
}

/** `DELETE /api/v1/ai/memory/{id}` — hard delete, effective in the same request (AC-3). */
export async function deleteMemoryEntry(userId: string, memoryId: string): Promise<void> {
  if (!isUuid(memoryId)) throw aiNotFoundError();
  const deleted = await getDb()
    .delete(aiMemories)
    .where(and(eq(aiMemories.id, memoryId), eq(aiMemories.userId, userId)))
    .returning({ key: aiMemories.key });
  if (deleted.length === 0) throw aiNotFoundError();
  console.log(JSON.stringify({ event: 'ai_assistant.memory_deleted', key: deleted[0]!.key }));
}

/** `DELETE /api/v1/ai/memory` — reset: every entry the caller owns. Conversations are untouched. */
export async function resetMemory(userId: string): Promise<void> {
  const deleted = await getDb().delete(aiMemories).where(eq(aiMemories.userId, userId)).returning({ id: aiMemories.id });
  console.log(JSON.stringify({ event: 'ai_assistant.memory_reset', count: deleted.length }));
}
