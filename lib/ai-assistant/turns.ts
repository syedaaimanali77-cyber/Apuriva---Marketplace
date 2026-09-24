/**
 * Spec 034 §3.3 (normal turn) and §3.11 (temporary turn).
 *
 * Both call `completeAi({ task: 'conversation' })` with the same `{ memory, turns }` input — system
 * instructions belong to the provider adapter's prompt template, never to `input`, so user content
 * stays separate from them (master spec §93). Both parse the reply envelope. They differ only in what
 * happens next:
 *
 * NORMAL — persists the user message and the reply in one transaction, may attach a validated
 * `memoryProposal` (never stored) and at most one action proposal from the executor port.
 *
 * TEMPORARY — CONVERSATION-ONLY. It writes no `ai_conversations`, `ai_messages`, `ai_memories` or
 * `ai_actions` row, keeps no idempotency record, logs no content, DISCARDS any memory proposal and
 * NEVER invokes the executor, at any risk tier (AC-14, AC-18). The transcript lives only in the
 * client's component state.
 */
import { sql } from 'drizzle-orm';
import { completeAi } from '@/lib/ai';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type {
  AiMemoryEntry,
  AiMemoryProposalDto,
  AiMessageDto,
  AiMessageRole,
  AiPendingConfirmationDto,
  AiTemporaryReplyDto,
} from '@/lib/types/ai-assistant';
import { runLowRiskAction } from './actions';
import { loadOwnedConversation, toMessageDto, transcriptOf, type StoredMessage } from './conversations';
import { aiNotFoundError, idempotencyKeyConflictError } from './errors';
import {
  getAiActionExecutor,
  isRejectedToolCall,
  type AiActionContext,
  type AiModelTool,
  type AiProposedAction,
  type AiRejectedToolCall,
} from './executor';
import { requireAskApurivaAvailable } from './feature-flags';
import { AI_TURN_BODY_MAX_LENGTH } from './limits';
import { memoryContextFor } from './memory';
import { summarizeMemoryValues, validateMemoryEntry } from './memory-keys';
import { parseReplyEnvelope } from './reply-envelope';
import { decideRisk } from './risk-policy';
import { replyFromOutcome } from './tool-outcome';

type Turn = { role: AiMessageRole; body: string };

function validateTurnBody(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw validationError([{ field, message: 'is required' }]);
  if (value.length > AI_TURN_BODY_MAX_LENGTH) {
    throw validationError([{ field, message: `must be at most ${AI_TURN_BODY_MAX_LENGTH} characters` }]);
  }
  return value;
}

/**
 * §3.3 step 3: `input` is `{ memory, turns }` as JSON — never system instructions. A normal turn
 * adds spec 036's model-facing catalogue as `tools`, as DATA, and only when it is non-empty; a
 * temporary turn never passes one, because it can never act (AC-18).
 */
async function callConversationModel(userId: string, turns: Turn[], tools: AiModelTool[] = []): Promise<string> {
  const memory = await memoryContextFor(userId);
  const { output } = await completeAi({
    task: 'conversation',
    subject: { kind: 'user', userId },
    input: JSON.stringify(tools.length > 0 ? { memory, turns, tools } : { memory, turns }),
  });
  return output;
}

/** Re-validates a proposal against the catalogue (a published category) and renders its summary. */
async function toMemoryProposal(entry: AiMemoryEntry | null): Promise<AiMemoryProposalDto | undefined> {
  if (!entry) return undefined;
  const validated = await validateMemoryEntry(entry.key, entry.value);
  if (!validated.ok) return undefined;
  const [valueSummary] = await summarizeMemoryValues([validated.entry]);
  return { ...validated.entry, valueSummary: valueSummary! };
}

/**
 * `POST /api/v1/ai/conversations/{id}/messages` (AC-1, AC-2, AC-13).
 *
 * A degradable AI error (spec 033's 429/503) propagates BEFORE anything is written, so the transcript
 * never holds a question the assistant never answered, and a retry with the same key re-attempts the
 * turn cleanly. The turn's `Idempotency-Key` is stored on the assistant row; a replay returns that
 * reply with `200` and spends no AI quota.
 */
export async function sendTurn(
  ctx: AiActionContext,
  idempotencyKey: string,
  rawBody: unknown,
): Promise<{ message: AiMessageDto; replayed: boolean }> {
  requireAskApurivaAvailable();

  const body = (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((field) => field !== 'body');
  if (extra.length > 0) throw validationError([{ field: 'body', message: `unexpected field(s): ${extra.join(', ')}` }]);
  const text = validateTurnBody(body.body, 'body');

  await loadOwnedConversation(getDb(), ctx.userId, ctx.conversationId);

  const fingerprint = idempotencyFingerprint({ conversationId: ctx.conversationId, body: text });
  const early = await findReplyByKey(ctx.conversationId, idempotencyKey);
  if (early) return replayTurn(early, fingerprint);

  const prior = await transcriptOf(getDb(), ctx.conversationId);
  const turns: Turn[] = [...prior.map((m) => ({ role: m.role, body: m.body })), { role: 'user', body: text }];

  const executor = getAiActionExecutor();
  const output = await callConversationModel(ctx.userId, turns, await executor.catalogFor(ctx));
  const envelope = parseReplyEnvelope(output);
  const memoryProposal = await toMemoryProposal(envelope.memoryProposal);

  // Specs 035/036 interpret the tool request; this spec applies the risk decision to the result.
  const proposed = await executor.interpretTurn(ctx, output);
  const { replyText, pendingConfirmation } = await applyProposedAction(ctx, turns, envelope.reply, proposed);

  let reply: StoredMessage;
  try {
    reply = await persistTurn(ctx.conversationId, text, replyText, idempotencyKey, fingerprint);
  } catch (err) {
    if (err instanceof TurnReplay) return replayTurn(err.row, fingerprint);
    throw err;
  }

  const message: AiMessageDto = toMessageDto(reply);
  if (memoryProposal) message.memoryProposal = memoryProposal;
  if (pendingConfirmation) message.pendingConfirmation = pendingConfirmation;

  return { message, replayed: false };
}

/**
 * The risk decision for the (at most one) tool call the executor interpreted, and the reply it
 * leaves (spec 036 §3):
 *
 *   - REJECTED (unknown/unavailable tool, or input failing its strict schema) — nothing runs or is
 *     recorded; the failure goes back to the model, whose reply explains it.
 *   - LOW — runs NOW, before the turn is persisted, and the reply is regenerated from its real
 *     outcome; the model's earlier text, written before anything ran, is never shown.
 *   - MEDIUM/HIGH — only PRESENTED (they need an explicit `POST …/confirm`); the reply is the model's.
 *   - RESTRICTED — dropped: never offered, never executed, never recorded (AC-7).
 *
 * A failing follow-up completion propagates like any model failure, so nothing is persisted.
 */
async function applyProposedAction(
  ctx: AiActionContext,
  turns: Turn[],
  modelReply: string,
  proposed: AiProposedAction | AiRejectedToolCall | null,
): Promise<{ replyText: string; pendingConfirmation?: AiPendingConfirmationDto }> {
  if (!proposed) return { replyText: modelReply };
  if (isRejectedToolCall(proposed)) {
    return { replyText: await replyFromOutcome(ctx.userId, turns, proposed.toolName, proposed.outcome) };
  }

  const decision = decideRisk(proposed.riskTier);
  if (decision.kind === 'execute') {
    const outcome = await runLowRiskAction(ctx, proposed);
    if (!outcome) return { replyText: modelReply };
    return { replyText: await replyFromOutcome(ctx.userId, turns, proposed.actionType, outcome) };
  }
  if (decision.kind === 'refuse' || !proposed.confirmationId) return { replyText: modelReply };
  return {
    replyText: modelReply,
    pendingConfirmation: {
      confirmationId: proposed.confirmationId,
      riskTier: decision.tier,
      actionLabel: proposed.actionLabel,
      parameters: proposed.parameters,
    },
  };
}

class TurnReplay extends Error {
  constructor(readonly row: StoredReply) {
    super('turn replay');
  }
}

interface StoredReply extends StoredMessage {
  fingerprint: string;
}

async function findReplyByKey(conversationId: string, idempotencyKey: string): Promise<StoredReply | null> {
  const [row] = await queryRows<{ id: string; role: AiMessageRole; body: string; created_at: Date; idempotency_fingerprint: string }>(
    getDb(),
    sql`SELECT id, role, body, created_at, idempotency_fingerprint FROM ai_messages
         WHERE ai_conversation_id = ${conversationId} AND idempotency_key = ${idempotencyKey}`,
  );
  return row
    ? { id: row.id, role: row.role, body: row.body, createdAt: new Date(row.created_at), fingerprint: row.idempotency_fingerprint }
    : null;
}

function replayTurn(row: StoredReply, fingerprint: string): { message: AiMessageDto; replayed: boolean } {
  if (row.fingerprint !== fingerprint) throw idempotencyKeyConflictError();
  return { message: toMessageDto(row), replayed: true };
}

/**
 * One transaction, conversation row locked: re-checks the key, inserts the user message and then the
 * reply with strictly increasing `created_at` (so `created_at, id` is a stable order even within one
 * millisecond), and stamps the conversation's `updated_at`. A deleted-meanwhile conversation is 404.
 */
async function persistTurn(
  conversationId: string,
  userText: string,
  replyText: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<StoredMessage> {
  try {
    return await getDb().transaction(async (tx) => {
      const [conversation] = await queryRows<{ user_id: string }>(
        tx,
        sql`SELECT user_id FROM ai_conversations WHERE id = ${conversationId} AND deleted_at IS NULL FOR UPDATE`,
      );
      if (!conversation) throw new Error('conversation vanished');

      const [locked] = await queryRows<{ id: string; role: AiMessageRole; body: string; created_at: Date; idempotency_fingerprint: string }>(
        tx,
        sql`SELECT id, role, body, created_at, idempotency_fingerprint FROM ai_messages
             WHERE ai_conversation_id = ${conversationId} AND idempotency_key = ${idempotencyKey}`,
      );
      if (locked) {
        throw new TurnReplay({
          id: locked.id,
          role: locked.role,
          body: locked.body,
          createdAt: new Date(locked.created_at),
          fingerprint: locked.idempotency_fingerprint,
        });
      }

      // Timestamps are derived IN SQL at microsecond precision: the reply is exactly 1µs after its
      // user message, which is itself after every earlier message, so `created_at, id` never ties.
      const [userRow] = await queryRows<{ id: string }>(
        tx,
        sql`WITH ts AS (
              SELECT GREATEST(clock_timestamp(),
                              COALESCE((SELECT max(created_at) FROM ai_messages WHERE ai_conversation_id = ${conversationId})
                                       + interval '1 microsecond', '-infinity'::timestamptz)) AS at
            )
            INSERT INTO ai_messages (ai_conversation_id, role, body, created_at, updated_at)
            SELECT ${conversationId}, 'user', ${userText}, ts.at, ts.at FROM ts
            RETURNING id`,
      );
      const [replyRow] = await queryRows<{ id: string; created_at: Date }>(
        tx,
        sql`WITH ts AS (SELECT created_at + interval '1 microsecond' AS at FROM ai_messages WHERE id = ${userRow!.id})
            INSERT INTO ai_messages (ai_conversation_id, role, body, idempotency_key, idempotency_fingerprint, created_at, updated_at)
            SELECT ${conversationId}, 'assistant', ${replyText}, ${idempotencyKey}, ${fingerprint}, ts.at, ts.at FROM ts
            RETURNING id, created_at`,
      );
      await tx.execute(sql`
        UPDATE ai_conversations
           SET updated_at = (SELECT created_at FROM ai_messages WHERE id = ${replyRow!.id}), version = version + 1
         WHERE id = ${conversationId}
      `);
      return { id: replyRow!.id, role: 'assistant' as const, body: replyText, createdAt: new Date(replyRow!.created_at) };
    });
  } catch (err) {
    if (err instanceof TurnReplay) throw err;
    if (err instanceof Error && err.message === 'conversation vanished') throw aiNotFoundError();
    if (isUniqueViolation(err, 'ai_messages_conversation_idempotency_key_uq')) {
      const raced = await findReplyByKey(conversationId, idempotencyKey);
      if (raced) throw new TurnReplay(raced);
    }
    throw err;
  }
}

/**
 * `POST /api/v1/ai/temporary-turns` (AC-14, AC-18). Server-stateless and conversation-only. The
 * whole temporary transcript arrives from the client each turn; a forged assistant turn gains
 * nothing because all of `input` is untrusted content, no confirmation is ever inferred from text,
 * and this function can neither act nor write.
 */
export async function sendTemporaryTurn(userId: string, rawBody: unknown): Promise<AiTemporaryReplyDto> {
  requireAskApurivaAvailable();

  const body = (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((field) => field !== 'turns');
  if (extra.length > 0) throw validationError([{ field: 'body', message: `unexpected field(s): ${extra.join(', ')}` }]);
  if (!Array.isArray(body.turns) || body.turns.length === 0) {
    throw validationError([{ field: 'turns', message: 'must be a non-empty list' }]);
  }

  const turns: Turn[] = body.turns.map((raw, i) => {
    const turn = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const unexpected = Object.keys(turn).filter((field) => field !== 'role' && field !== 'body');
    if (unexpected.length > 0) throw validationError([{ field: `turns[${i}]`, message: `unexpected field(s): ${unexpected.join(', ')}` }]);
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      throw validationError([{ field: `turns[${i}].role`, message: 'must be user or assistant' }]);
    }
    return { role: turn.role, body: validateTurnBody(turn.body, `turns[${i}].body`) };
  });
  if (turns[turns.length - 1]!.role !== 'user') {
    throw validationError([{ field: 'turns', message: 'must end with a user turn' }]);
  }

  const output = await callConversationModel(userId, turns);
  // The memory proposal, if any, is DISCARDED: a temporary conversation can never create memory.
  const { reply } = parseReplyEnvelope(output);
  return { role: 'assistant', body: reply };
}
