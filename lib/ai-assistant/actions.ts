/**
 * Spec 034 §3.4, §3.5, §3.8 — recording and running assistant actions, the confirmation flow, and
 * activity history.
 *
 * The row is inserted with `result = 'pending'` BEFORE the executor runs and its id is passed
 * through (spec 036's `ai_tool_calls` reference it). Only the outcome the executor CONFIRMS moves it
 * to `succeeded`/`failed`; if the executor throws or the process dies, the row stays `pending`,
 * shown as "outcome unknown" — never as a success (master spec §92).
 *
 * `reversible` is always `false`: specs 035/036 declare no reversal (§3.8), so there is no Undo.
 * No free text is stored: the label is derived at read time through the executor port.
 */
import { sql } from 'drizzle-orm';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { AiActionDto, AiActionRiskTier } from '@/lib/types/ai-assistant';
import { loadOwnedConversation } from './conversations';
import { aiNotFoundError, idempotencyKeyConflictError } from './errors';
import { getAiActionExecutor, type AiActionContext, type AiProposedAction } from './executor';
import { requireAskApurivaAvailable } from './feature-flags';
import { decideRisk } from './risk-policy';

interface ActionRow {
  id: string;
  ai_conversation_id: string;
  action_type: string;
  risk_tier: AiActionRiskTier;
  required_confirmation: boolean;
  result: AiActionDto['result'];
  reversible: boolean;
  related_entity_type: 'request' | 'booking' | null;
  related_entity_id: string | null;
  created_at: Date;
  idempotency_fingerprint?: string | null;
}

function toActionDto(row: ActionRow, actionLabel: string): AiActionDto {
  return {
    id: row.id,
    conversationId: row.ai_conversation_id,
    actionLabel,
    riskTier: row.risk_tier,
    requiredConfirmation: row.required_confirmation,
    result: row.result,
    related:
      row.related_entity_type && row.related_entity_id ? { type: row.related_entity_type, id: row.related_entity_id } : null,
    reversible: row.reversible,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const ACTION_COLUMNS = sql`id, ai_conversation_id, action_type, risk_tier, required_confirmation, result, reversible,
                           related_entity_type, related_entity_id, created_at, idempotency_fingerprint`;

async function insertPendingAction(
  conversationId: string,
  action: AiProposedAction,
  tier: AiActionRiskTier,
  idempotency: { key: string; fingerprint: string } | null,
): Promise<ActionRow> {
  const [row] = await queryRows<ActionRow>(
    getDb(),
    sql`INSERT INTO ai_actions (ai_conversation_id, action_type, risk_tier, required_confirmation, result, reversible,
                                related_entity_type, related_entity_id, idempotency_key, idempotency_fingerprint)
        VALUES (${conversationId}, ${action.actionType}, ${tier}, ${tier !== 'low'}, 'pending', false,
                ${action.related?.type ?? null}, ${action.related?.id ?? null},
                ${idempotency?.key ?? null}, ${idempotency?.fingerprint ?? null})
        RETURNING ${ACTION_COLUMNS}`,
  );
  return row!;
}

/**
 * Runs the executor for a recorded row. Only a confirmed outcome is written; a throw leaves the row
 * `pending` ("outcome unknown") and is re-thrown so a route passes spec 035's error through.
 */
async function executeRecorded(ctx: AiActionContext, row: ActionRow, action: AiProposedAction): Promise<ActionRow> {
  let outcome: { succeeded: boolean };
  try {
    outcome = await getAiActionExecutor().execute(ctx, row.id, action);
  } catch (err) {
    console.error(JSON.stringify({ event: 'ai_assistant.action_outcome_unknown', aiActionId: row.id, error: String(err) }));
    throw err;
  }
  const [updated] = await queryRows<ActionRow>(
    getDb(),
    sql`UPDATE ai_actions
           SET result = ${outcome.succeeded ? 'succeeded' : 'failed'}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${row.id} AND result = 'pending'
     RETURNING ${ACTION_COLUMNS}`,
  );
  return updated ?? row;
}

/**
 * A LOW-risk action proposed during a normal turn runs immediately, without confirmation (AC-4).
 * A throw is logged and swallowed here — the turn's reply is still returned and the row stays
 * `pending` — because the user never asked this call to act; activity history shows the truth.
 */
export async function runLowRiskAction(ctx: AiActionContext, action: AiProposedAction): Promise<void> {
  if (decideRisk(action.riskTier).kind !== 'execute') return;
  const row = await insertPendingAction(ctx.conversationId, action, 'low', null);
  try {
    await executeRecorded(ctx, row, action);
  } catch {
    // Already logged by executeRecorded; the row remains `pending` ("outcome unknown").
  }
}

/**
 * `POST /api/v1/ai/conversations/{id}/confirm` (AC-5, AC-6). A confirmation is a REQUEST carrying
 * spec 035's `confirmationId` — never an interpretation of message text. Replay-safe through the
 * `Idempotency-Key` stored on the action row.
 */
export async function confirmAction(
  ctx: AiActionContext,
  idempotencyKey: string,
  rawBody: unknown,
): Promise<{ action: AiActionDto; replayed: boolean }> {
  requireAskApurivaAvailable();

  const body = (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((field) => field !== 'confirmationId');
  if (extra.length > 0) throw validationError([{ field: 'body', message: `unexpected field(s): ${extra.join(', ')}` }]);
  if (typeof body.confirmationId !== 'string' || body.confirmationId.trim().length === 0) {
    throw validationError([{ field: 'confirmationId', message: 'is required' }]);
  }
  const confirmationId = body.confirmationId;

  // Session-bound: the confirmation must belong to a conversation the caller owns.
  await loadOwnedConversation(getDb(), ctx.userId, ctx.conversationId);

  const fingerprint = idempotencyFingerprint({ conversationId: ctx.conversationId, confirmationId });
  const existing = await findActionByKey(ctx.conversationId, idempotencyKey);
  if (existing) return replayAction(existing, fingerprint);

  const executor = getAiActionExecutor();
  // `null` → 404. A stale confirmation throws spec 035's own error, passed through unchanged (§3.7).
  const action = await executor.resolveConfirmation(ctx, confirmationId);
  if (!action) throw aiNotFoundError();

  const decision = decideRisk(action.riskTier);
  // Only medium/high actions are ever confirmable; a restricted one is never offered (AC-7) and a
  // low one never needed a confirmation, so neither can be confirmed into existence here.
  if (decision.kind !== 'confirm') throw aiNotFoundError();

  let row: ActionRow;
  try {
    row = await insertPendingAction(ctx.conversationId, action, decision.tier, { key: idempotencyKey, fingerprint });
  } catch (err) {
    if (!isUniqueViolation(err, 'ai_actions_conversation_idempotency_key_uq')) throw err;
    const raced = await findActionByKey(ctx.conversationId, idempotencyKey);
    if (!raced) throw err;
    return replayAction(raced, fingerprint);
  }

  const executed = await executeRecorded(ctx, row, action);
  return { action: toActionDto(executed, action.actionLabel), replayed: false };
}

async function findActionByKey(conversationId: string, idempotencyKey: string): Promise<ActionRow | null> {
  const [row] = await queryRows<ActionRow>(
    getDb(),
    sql`SELECT ${ACTION_COLUMNS} FROM ai_actions WHERE ai_conversation_id = ${conversationId} AND idempotency_key = ${idempotencyKey}`,
  );
  return row ?? null;
}

function replayAction(row: ActionRow, fingerprint: string): { action: AiActionDto; replayed: boolean } {
  if (row.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
  return { action: toActionDto(row, getAiActionExecutor().labelFor(row.action_type) ?? ''), replayed: true };
}

/**
 * `GET /api/v1/ai/activity` — the caller's activity, newest first (AC-10). Ownership comes from the
 * parent conversation, INCLUDING tombstoned ones: deleting a conversation never erases what the
 * assistant did. An action whose tool declares no plain-language label is not shown (§8 risk 6) —
 * a raw tool identifier never reaches the client (§85).
 */
export async function listActivity(
  userId: string,
  page: PageParams,
): Promise<{ data: AiActionDto[]; page: ReturnType<typeof buildPage> }> {
  const rows = await queryRows<ActionRow>(
    getDb(),
    sql`SELECT a.id, a.ai_conversation_id, a.action_type, a.risk_tier, a.required_confirmation, a.result, a.reversible,
               a.related_entity_type, a.related_entity_id, a.created_at
          FROM ai_actions a
          JOIN ai_conversations c ON c.id = a.ai_conversation_id
         WHERE c.user_id = ${userId}
         ORDER BY a.created_at DESC, a.id DESC`,
  );

  const executor = getAiActionExecutor();
  const labelled = rows.flatMap((row) => {
    const label = executor.labelFor(row.action_type);
    return label ? [toActionDto(row, label)] : [];
  });

  return {
    data: labelled.slice(page.offset, page.offset + page.limit),
    page: buildPage(labelled.length, page.limit, page.offset),
  };
}
