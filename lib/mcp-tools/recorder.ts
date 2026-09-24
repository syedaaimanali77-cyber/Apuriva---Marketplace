/**
 * Spec 036 §4 — the `ai_tool_calls` record and the server-generated idempotency key.
 *
 * One row per EXECUTION attempt of an `ai_actions` row. The key is generated server-side on the
 * first attempt of a state-changing tool for that action and REUSED by every later attempt for the
 * same action (a retry or a replay), so the domain sees one key per accepted intent and replays its
 * original result (AC-2, AC-3). The AI never supplies, sees or controls it.
 *
 * `input_params`/`output_summary` hold only the redacted structure built by `fields.ts` /
 * `ToolOutputSummary` — never content (AC-9).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';

/** §4 `output_summary`: the resulting resource's type, id and status — and nothing else. */
export interface ToolOutputSummary {
  type: string;
  id: string | null;
  status: string | null;
}

/** The key already issued for this accepted intent, or a fresh server-generated one. */
export async function idempotencyKeyForAction(aiActionId: string): Promise<string> {
  const [existing] = await queryRows<{ idempotency_key: string }>(
    getDb(),
    sql`SELECT idempotency_key FROM ai_tool_calls
         WHERE ai_action_id = ${aiActionId} AND idempotency_key IS NOT NULL
         ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  return existing?.idempotency_key ?? randomUUID();
}

export async function beginToolCall(input: {
  aiActionId: string;
  idempotencyKey: string | null;
  inputParams: Record<string, unknown>;
  retriedFromCallId: string | null;
}): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO ai_tool_calls (ai_action_id, idempotency_key, input_params, retried_from_call_id)
        VALUES (${input.aiActionId}, ${input.idempotencyKey}, ${JSON.stringify(input.inputParams)}::jsonb, ${input.retriedFromCallId})
        RETURNING id`,
  );
  return row!.id;
}

export async function completeToolCall(
  callId: string,
  result: { outputSummary: ToolOutputSummary | null; errorCode: string | null },
): Promise<void> {
  await getDb().execute(sql`
    UPDATE ai_tool_calls
       SET output_summary = ${result.outputSummary === null ? null : JSON.stringify(result.outputSummary)}::jsonb,
           error_code = ${result.errorCode},
           updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${callId}
  `);
}
