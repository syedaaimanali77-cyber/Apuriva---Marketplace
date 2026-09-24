/**
 * Spec 035 §3 — this spec's implementation of spec 034's `AiActionExecutor` port. Registered from
 * `instrumentation.ts`, the pattern specs 021, 027, 030 and 034 already use. Spec 036's catalogue
 * executor (`lib/mcp-tools/executor.ts`) is registered after it and takes its place; both reach a
 * tool ONLY through `authorizeAndExecute`, so no execution path skips the eight checks.
 *
 * What this spec does NOT own, and does not touch here: the conversation surface, the risk
 * decision (`risk-policy.ts`), presenting and accepting confirmations, and the `ai_actions` rows
 * — all spec 034's (§7). Nothing in `lib/mcp` reads or writes `ai_actions`.
 *
 * WITH AN EMPTY REGISTRY THIS EXECUTOR IS INERT BY CONSEQUENCE, not by a special case. This spec
 * registers no business tool (spec 036 owns the catalogue), so:
 *   - `interpretTurn` finds no tool a turn could be proposing and returns null, exactly as the
 *     pre-035 default did — the assistant proposes nothing;
 *   - `execute` refuses, because an action naming a tool that is not registered fails step 1 of
 *     the pipeline rather than running;
 *   - `labelFor` answers only for registered tools, so an unknown `action_type` stays out of
 *     activity history (spec 034 §8 risk 6).
 *
 * How a model REQUESTS a tool — the wire shape of a tool call in model output — is defined by the
 * spec that ships the catalogue (036), together with the tools themselves. This spec deliberately
 * invents no envelope: with nothing to name, there is nothing to parse.
 *
 * Spec 036 AC-8: the mode comes from the caller's live session (`resolveSessionActiveMode`), never
 * a hard-coded value.
 */
import { sql } from 'drizzle-orm';
import {
  registerAiActionExecutor,
  type AiActionContext,
  type AiActionExecutor,
  type AiActionOutcome,
  type AiProposedAction,
} from '@/lib/ai-assistant/executor';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { ActiveMode } from '@/lib/types/users';
import { authorizeAndExecute } from './authorize';
import { readMcpConfirmation } from './confirmation';
import { findUserTool, listMcpTools } from './registry';
import type { McpAuthContext } from './types';

/**
 * Spec 036 AC-8 — the caller's CURRENT `sessions.active_mode`, read server-side from the session
 * spec 034 already authenticated. Null when that session no longer resolves (revoked, expired, or
 * not this user's); the caller then fails step 1 of the pipeline rather than assuming a mode.
 */
export async function resolveSessionActiveMode(userId: string, sessionId: string): Promise<ActiveMode | null> {
  const [row] = await queryRows<{ active_mode: ActiveMode }>(
    getDb(),
    sql`SELECT active_mode FROM sessions
         WHERE id = ${sessionId} AND user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()`,
  );
  return row?.active_mode ?? null;
}

/**
 * The authorization context for a conversation: always a user surface, never an admin, in the
 * caller's current mode (spec 036 AC-8 — no hard-coded mode). A session that no longer resolves
 * yields an empty `sessionId`, so the pipeline refuses at step 1 (authenticated identity); the mode
 * it carries then is never consulted.
 */
export async function mcpAuthContextFor(ctx: AiActionContext): Promise<McpAuthContext> {
  const activeMode = await resolveSessionActiveMode(ctx.userId, ctx.sessionId);
  if (!activeMode) return { userId: ctx.userId, sessionId: '', activeMode: 'customer', isAdmin: false };
  return { userId: ctx.userId, sessionId: ctx.sessionId, activeMode, isAdmin: false };
}

const MCP_EXECUTOR: AiActionExecutor = {
  /**
   * No registered tool can be named by a turn while the catalogue is empty, so nothing is
   * proposed. Spec 036 supplies both the tools and how a turn names one.
   */
  async interpretTurn() {
    return null;
  },

  /**
   * Spec 034 calls this from `POST …/confirm`. It returns the proposal the stored binding
   * describes, or null for `404`. Staleness is not decided here — a binding is compared against
   * the parameters of the call being authorized, in step 6 of the pipeline — so a record that
   * merely exists is returned and the pipeline refuses it if it no longer binds.
   */
  async resolveConfirmation(ctx, confirmationId): Promise<AiProposedAction | null> {
    const record = await readMcpConfirmation(confirmationId, ctx.userId);
    if (!record) return null;

    const tool = findUserTool(record.toolName);
    if (!tool) return null;

    return {
      actionType: tool.name,
      actionLabel: tool.label,
      riskTier: record.riskTier,
      parameters: record.parameters.map((parameter) => ({ label: parameter.label, value: parameter.value })),
      related: null,
      confirmationId: record.id,
    };
  },

  /**
   * Runs the action through all eight checks. There is no path that skips them. The input is the
   * server-held validated input the proposal carries (spec 036 §3), never anything re-supplied. A
   * refusal throws, which spec 034 records as "outcome unknown"; spec 036's catalogue executor,
   * registered after this one, returns structured failures instead.
   */
  async execute(ctx, _aiActionId, action): Promise<AiActionOutcome> {
    const context: McpAuthContext = {
      ...(await mcpAuthContextFor(ctx)),
      confirmationId: action.confirmationId,
    };
    const result = await authorizeAndExecute(
      {
        toolName: action.actionType,
        rawInput: action.input ?? {},
        parameters: action.parameters.map((parameter) => ({ label: parameter.label, value: parameter.value })),
        surface: 'user',
      },
      context,
    );
    return { status: 'succeeded', data: result.data };
  },

  /** Plain-language label, from the registry. Null keeps an unknown action out of history. */
  labelFor(actionType) {
    return listMcpTools().find((tool) => tool.name === actionType)?.label ?? null;
  },

  /** No catalogue of its own: spec 036 supplies the model-facing catalogue with its tools. */
  async catalogFor() {
    return [];
  },
};

/** Called once from `instrumentation.ts`. Makes spec 034's port real. */
export function registerMcpIntegration(): void {
  registerAiActionExecutor(MCP_EXECUTOR);
}

export { MCP_EXECUTOR };
