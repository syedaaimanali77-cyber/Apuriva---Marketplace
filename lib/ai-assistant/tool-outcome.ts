/**
 * Spec 034 §3.4 as amended by spec 036 — how a tool's REAL outcome reaches the conversation model.
 *
 * Master spec §87's core flow ends "Result returned → AI reports truthfully". So after an action
 * runs, the model is asked again with the outcome as DATA in the `conversation` input
 * (`{ memory, turns, toolResult }`), and the user-facing reply about the action is generated ONLY
 * from that outcome — never from the reply the model wrote before the action ran (§92, §132.8).
 *
 * The outcome is never persisted as a message and never logged; only the model's reply is stored,
 * like any other assistant turn. No catalogue is offered to the follow-up, so it cannot chain a
 * second tool call (at most one per turn, §3.4).
 */
import { sql } from 'drizzle-orm';
import { completeAi } from '@/lib/ai';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { AiMessageDto, AiMessageRole } from '@/lib/types/ai-assistant';
import { toMessageDto, transcriptOf, type StoredMessage } from './conversations';
import type { AiActionContext, AiActionOutcome } from './executor';
import { memoryContextFor } from './memory';
import { parseReplyEnvelope } from './reply-envelope';

export type ConversationTurn = { role: AiMessageRole; body: string };

/** The follow-up completion: the model answers from the outcome it is given, and from nothing else. */
export async function replyFromOutcome(
  userId: string,
  turns: ConversationTurn[],
  toolName: string,
  outcome: AiActionOutcome,
): Promise<string> {
  const memory = await memoryContextFor(userId);
  const { output } = await completeAi({
    task: 'conversation',
    subject: { kind: 'user', userId },
    input: JSON.stringify({ memory, turns, toolResult: { tool: toolName, outcome } }),
  });
  return parseReplyEnvelope(output).reply;
}

/**
 * After `POST …/confirm` executed an action: the model's reply from the real outcome, appended to the
 * transcript. If the follow-up cannot be produced (spec 033's provider unavailable, quota exhausted,
 * or the conversation was deleted meanwhile) there is NO reply — the recorded action and its real
 * result stand on their own, and nothing is invented in its place.
 */
export async function replyAfterConfirmedAction(
  ctx: AiActionContext,
  toolName: string,
  outcome: AiActionOutcome,
  idempotency: { key: string; fingerprint: string },
): Promise<AiMessageDto | undefined> {
  try {
    const transcript = await transcriptOf(getDb(), ctx.conversationId);
    const turns = transcript.map((message) => ({ role: message.role, body: message.body }));
    const reply = await replyFromOutcome(ctx.userId, turns, toolName, outcome);
    const stored = await appendAssistantMessage(ctx.conversationId, reply, idempotency);
    return stored ? toMessageDto(stored) : undefined;
  } catch (err) {
    console.error(JSON.stringify({ event: 'ai_assistant.action_reply_unavailable', conversationId: ctx.conversationId, error: String(err) }));
    return undefined;
  }
}

/**
 * Appends one assistant message after every earlier one (the same strictly increasing
 * `created_at` rule `persistTurn` uses) and stamps the conversation. Null if the conversation was
 * deleted meanwhile. Like every assistant message (`ai_messages_idempotency_ck`), it carries the
 * request's `Idempotency-Key` and fingerprint — here the confirmation's own; a replayed confirm is
 * answered from `ai_actions` and never reaches here.
 */
async function appendAssistantMessage(
  conversationId: string,
  body: string,
  idempotency: { key: string; fingerprint: string },
): Promise<StoredMessage | null> {
  return getDb().transaction(async (tx) => {
    const [conversation] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM ai_conversations WHERE id = ${conversationId} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (!conversation) return null;

    const [row] = await queryRows<{ id: string; created_at: Date }>(
      tx,
      sql`WITH ts AS (
            SELECT GREATEST(clock_timestamp(),
                            COALESCE((SELECT max(created_at) FROM ai_messages WHERE ai_conversation_id = ${conversationId})
                                     + interval '1 microsecond', '-infinity'::timestamptz)) AS at
          )
          INSERT INTO ai_messages (ai_conversation_id, role, body, idempotency_key, idempotency_fingerprint, created_at, updated_at)
          SELECT ${conversationId}, 'assistant', ${body}, ${idempotency.key}, ${idempotency.fingerprint}, ts.at, ts.at FROM ts
          RETURNING id, created_at`,
    );
    await tx.execute(sql`
      UPDATE ai_conversations
         SET updated_at = (SELECT created_at FROM ai_messages WHERE id = ${row!.id}), version = version + 1
       WHERE id = ${conversationId}
    `);
    return { id: row!.id, role: 'assistant' as const, body, createdAt: new Date(row!.created_at) };
  });
}
