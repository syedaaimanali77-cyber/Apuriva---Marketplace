/**
 * Spec 036 test support. Shared by this spec's suites only.
 *
 * Everything runs against the REAL catalogue, the REAL spec 035 pipeline and the REAL domain modules
 * on the isolated `*_test` database. The only things created directly are the spec 034 rows a tool
 * call hangs off (a conversation and its `ai_actions` row), because spec 034's own routes are
 * exercised end to end in `e2e/ai-booking-flow.spec.ts`.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { resetAiActionExecutor, type AiActionContext } from '@/lib/ai-assistant/executor';
import { getDb } from '@/lib/db';
import { resetMcpAuditSinkForTests } from '@/lib/mcp/audit';
import { resetMcpRegistryForTests } from '@/lib/mcp/registry';
import { queryRows } from '@/lib/offers/db';
import type { ActiveMode } from '@/lib/types/users';
import { registerMcpToolCatalog } from './catalog';
import { MCP_TOOLS_EXECUTOR } from './executor';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** Registers exactly what `instrumentation.ts` registers: the catalogue and its executor. */
export async function useToolCatalog(): Promise<typeof MCP_TOOLS_EXECUTOR> {
  resetMcpRegistryForTests();
  resetMcpAuditSinkForTests();
  await registerMcpToolCatalog();
  return MCP_TOOLS_EXECUTOR;
}

export function resetToolCatalog(): void {
  resetMcpRegistryForTests();
  resetMcpAuditSinkForTests();
  resetAiActionExecutor();
}

/** A stored conversation for the user — what every executor call is scoped to. */
export async function seedConversation(userId: string): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO ai_conversations (user_id, idempotency_key, idempotency_fingerprint)
        VALUES (${userId}, ${randomUUID()}, ${randomUUID()}) RETURNING id`,
  );
  return row!.id;
}

/** The `ai_actions` row spec 034 inserts (as `pending`) before it calls `execute`. */
export async function seedPendingAction(conversationId: string, actionType: string, riskTier: 'low' | 'medium' | 'high'): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO ai_actions (ai_conversation_id, action_type, risk_tier, required_confirmation, result)
        VALUES (${conversationId}, ${actionType}, ${riskTier}, ${riskTier !== 'low'}, 'pending') RETURNING id`,
  );
  return row!.id;
}

export function contextFor(session: { userId: string; sessionId: string }, conversationId: string): AiActionContext {
  return { userId: session.userId, sessionId: session.sessionId, conversationId };
}

/** The model output carrying spec 036's envelope member. */
export function toolCallOutput(name: string, input: Record<string, unknown>, reply = 'On it.'): string {
  return JSON.stringify({ reply, toolCall: { name, input } });
}

export async function setActiveMode(sessionId: string, mode: ActiveMode): Promise<void> {
  await getDb().execute(sql`UPDATE sessions SET active_mode = ${mode} WHERE id = ${sessionId}`);
}

export interface ToolCallRow {
  id: string;
  idempotency_key: string | null;
  input_params: Record<string, unknown>;
  output_summary: { type: string; id: string | null; status: string | null } | null;
  error_code: string | null;
  retried_from_call_id: string | null;
}

export async function toolCallRows(aiActionId: string): Promise<ToolCallRow[]> {
  return queryRows<ToolCallRow>(
    getDb(),
    sql`SELECT id, idempotency_key, input_params, output_summary, error_code, retried_from_call_id
          FROM ai_tool_calls WHERE ai_action_id = ${aiActionId} ORDER BY created_at ASC, id ASC`,
  );
}

export async function confirmationRows(confirmationId: string): Promise<Array<{ label: string; value: string }>> {
  return queryRows<{ label: string; value: string }>(
    getDb(),
    sql`SELECT label, value FROM mcp_confirmation_parameters WHERE mcp_confirmation_id = ${confirmationId} ORDER BY sort_order, label`,
  );
}

export async function countBookingsForOffer(offerId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM bookings WHERE offer_id = ${offerId}`);
  return row!.n;
}
