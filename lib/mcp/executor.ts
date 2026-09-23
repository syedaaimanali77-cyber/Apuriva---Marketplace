/**
 * Spec 035 §3 — this spec's implementation of spec 034's `AiActionExecutor` port, and the ONLY
 * way MCP reaches the assistant. Registered from `instrumentation.ts`, the pattern specs 021,
 * 027, 030 and 034 already use. No parallel AI execution path exists or may be added.
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
 */
import { registerAiActionExecutor, type AiActionContext, type AiActionExecutor, type AiProposedAction } from '@/lib/ai-assistant/executor';
import { authorizeAndExecute } from './authorize';
import { readMcpConfirmation } from './confirmation';
import { findUserTool, listMcpTools } from './registry';
import type { McpAuthContext } from './types';

/**
 * Spec 034's `AiActionContext` carries no mode or admin flag, so the executor cannot invent one:
 * a conversation is a user surface in the caller's current mode. Until spec 036 threads the live
 * session mode through the port, actions run as `customer` and never as an admin — the narrower
 * of the two, so a mode-restricted tool refuses rather than running with more reach than the
 * caller has.
 */
function authContextFor(ctx: AiActionContext): McpAuthContext {
  return { userId: ctx.userId, sessionId: ctx.sessionId, activeMode: 'customer', isAdmin: false };
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

  /** Runs the action through all eight checks. There is no path that skips them. */
  async execute(ctx, _aiActionId, action): Promise<{ succeeded: boolean }> {
    const context: McpAuthContext = {
      ...authContextFor(ctx),
      confirmationId: action.confirmationId,
    };
    const result = await authorizeAndExecute(
      {
        toolName: action.actionType,
        rawInput: {},
        parameters: action.parameters.map((parameter) => ({ label: parameter.label, value: parameter.value })),
        surface: 'user',
      },
      context,
    );
    return { succeeded: result.success };
  },

  /** Plain-language label, from the registry. Null keeps an unknown action out of history. */
  labelFor(actionType) {
    return listMcpTools().find((tool) => tool.name === actionType)?.label ?? null;
  },
};

/** Called once from `instrumentation.ts`. Makes spec 034's port real. */
export function registerMcpIntegration(): void {
  registerAiActionExecutor(MCP_EXECUTOR);
}

export { MCP_EXECUTOR };
