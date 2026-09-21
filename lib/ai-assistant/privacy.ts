/**
 * Spec 034 §4 "Retention and privacy" (AC-16, AC-17) — this spec's sections of spec 008's EXISTING
 * export and deletion flows, exactly as specs 024/026/027 contribute theirs. No parallel mechanism.
 *
 * RETENTION: there is no time-based period and no sweep here. A normal conversation lives until the
 * user deletes it or the account deletion sweep below removes it. Temporary conversations are never
 * stored, so there is nothing of them to export or delete.
 */
import { asc, eq, inArray, isNull, and, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiActions, aiConversations, aiMemories, aiMessages } from '@/lib/db/schema';
import type { Executor } from '@/lib/offers/db';
import type { AiMemoryEntry, AiMemoryKey } from '@/lib/types/ai-assistant';
import { getAiActionExecutor } from './executor';
import { summarizeMemoryValues } from './memory-keys';

export interface ExportedAiAssistantData {
  /** Non-deleted conversations with their messages, in transcript order. */
  conversations: Array<{
    id: string;
    createdAt: string;
    updatedAt: string;
    messages: Array<{ role: 'user' | 'assistant'; body: string; createdAt: string }>;
  }>;
  memory: Array<{ key: AiMemoryKey; value: unknown; valueSummary: string; createdAt: string; updatedAt: string }>;
  /**
   * Activity entries, including those of deleted conversations. `actionLabel` is the plain-language
   * label (null when the tool declares none); the raw `action_type` is never exported (§85).
   */
  activity: Array<{
    id: string;
    conversationId: string;
    actionLabel: string | null;
    riskTier: string;
    requiredConfirmation: boolean;
    result: string;
    related: { type: 'request' | 'booking'; id: string } | null;
    createdAt: string;
  }>;
}

export async function exportAiAssistantData(userId: string): Promise<ExportedAiAssistantData> {
  const db = getDb();

  const conversationRows = await db
    .select({ id: aiConversations.id, createdAt: aiConversations.createdAt, updatedAt: aiConversations.updatedAt })
    .from(aiConversations)
    .where(and(eq(aiConversations.userId, userId), isNull(aiConversations.deletedAt)))
    .orderBy(asc(aiConversations.createdAt), asc(aiConversations.id));
  const conversationIds = conversationRows.map((c) => c.id);
  const messageRows = conversationIds.length
    ? await db
        .select({
          conversationId: aiMessages.aiConversationId,
          role: aiMessages.role,
          body: aiMessages.body,
          createdAt: aiMessages.createdAt,
        })
        .from(aiMessages)
        .where(inArray(aiMessages.aiConversationId, conversationIds))
        .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
    : [];

  const memoryRows = await db
    .select({ key: aiMemories.key, value: aiMemories.value, createdAt: aiMemories.createdAt, updatedAt: aiMemories.updatedAt })
    .from(aiMemories)
    .where(eq(aiMemories.userId, userId))
    .orderBy(asc(aiMemories.createdAt), asc(aiMemories.id));
  const summaries = await summarizeMemoryValues(memoryRows.map((m) => ({ key: m.key, value: m.value }) as AiMemoryEntry));

  const actionRows = await db
    .select({
      id: aiActions.id,
      conversationId: aiActions.aiConversationId,
      actionType: aiActions.actionType,
      riskTier: aiActions.riskTier,
      requiredConfirmation: aiActions.requiredConfirmation,
      result: aiActions.result,
      relatedEntityType: aiActions.relatedEntityType,
      relatedEntityId: aiActions.relatedEntityId,
      createdAt: aiActions.createdAt,
    })
    .from(aiActions)
    .innerJoin(aiConversations, eq(aiConversations.id, aiActions.aiConversationId))
    .where(eq(aiConversations.userId, userId))
    .orderBy(asc(aiActions.createdAt), asc(aiActions.id));
  const executor = getAiActionExecutor();

  return {
    conversations: conversationRows.map((c) => ({
      id: c.id,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messages: messageRows
        .filter((m) => m.conversationId === c.id)
        .map((m) => ({ role: m.role, body: m.body, createdAt: m.createdAt.toISOString() })),
    })),
    memory: memoryRows.map((m, i) => ({
      key: m.key,
      value: m.value,
      valueSummary: summaries[i]!,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    activity: actionRows.map((a) => ({
      id: a.id,
      conversationId: a.conversationId,
      actionLabel: executor.labelFor(a.actionType),
      riskTier: a.riskTier,
      requiredConfirmation: a.requiredConfirmation,
      result: a.result,
      related: a.relatedEntityType && a.relatedEntityId ? { type: a.relatedEntityType, id: a.relatedEntityId } : null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * Account deletion sweep: hard-deletes the user's `ai_messages` and `ai_memories` (nothing
 * references either) and tombstones their conversations. `ai_actions` rows are RETAINED, keyed to
 * the now-anonymized user through their conversation; they carry no free text, so nothing needs
 * redacting.
 */
export async function removeAiAssistantDataForDeletedUser(db: Executor, userId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM ai_messages
     WHERE ai_conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = ${userId})
  `);
  await db.execute(sql`DELETE FROM ai_memories WHERE user_id = ${userId}`);
  await db.execute(sql`
    UPDATE ai_conversations
       SET deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE user_id = ${userId} AND deleted_at IS NULL
  `);
}
