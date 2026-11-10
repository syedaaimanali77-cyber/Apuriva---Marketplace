/**
 * Spec 036 §3 — the catalogue's implementation of spec 034's `AiActionExecutor` port. Registered
 * from `instrumentation.ts` after spec 035's executor, whose place it takes. Every execution goes
 * through spec 035's `authorizeAndExecute` — the one pipeline; nothing here calls a tool directly.
 *
 *   interpretTurn       reads the model's `toolCall: { name, input }` (the envelope member this spec
 *                       defines), validates it strictly, and either PROPOSES it (low: to run now;
 *                       medium/high: with a spec 035 confirmation holding display + binding rows)
 *                       or REJECTS it back to the model — never silently.
 *   resolveConfirmation restores the validated input from the binding rows (never from the model or
 *                       the client) and re-derives the display rows from LIVE data; any change, an
 *                       expiry or a prior use is spec 035's `MCP_CONFIRMATION_STALE`, before spec 034
 *                       records anything.
 *   execute             issues/reuses the server idempotency key, records `ai_tool_calls`, runs the
 *                       pipeline, and returns the REAL outcome — `succeeded`, `failed` with the
 *                       domain's own code/message/details, or `unknown`. Never a fabricated success.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type {
  AiActionContext,
  AiActionExecutor,
  AiActionOutcome,
  AiProposedAction,
  AiRejectedToolCall,
} from '@/lib/ai-assistant/executor';
import { decideRisk } from '@/lib/ai-assistant/risk-policy';
import {
  authorizeAndExecute,
  bindingMatches,
  createMcpConfirmation,
  findUserTool,
  mcpAuthContextFor,
  mcpConfirmationStaleError,
  mcpToolNotAvailableInContextError,
  readMcpConfirmation,
  type McpAuthContext,
  type McpBoundParameter,
} from '@/lib/mcp';
import { findCatalogTool, modelCatalogFor } from './catalog';
import { toOutcome } from './errors';
import { decodeBinding, encodeBinding, redactInput } from './fields';
import { beginToolCall, completeToolCall, idempotencyKeyForAction } from './recorder';
import { shouldRetry } from './retry-policy';
import type { CatalogTool, ToolInput } from './tool';

/** The one envelope member this spec defines: at most one tool call per turn (spec 034 §3.4). */
function readToolCall(output: string): { name: unknown; input: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const toolCall = (parsed as Record<string, unknown>).toolCall;
  if (typeof toolCall !== 'object' || toolCall === null || Array.isArray(toolCall)) return null;
  const { name, input } = toolCall as Record<string, unknown>;
  return { name, input };
}

function rejected(toolName: string, err: unknown): AiRejectedToolCall {
  const outcome = toOutcome(err);
  // Only a structured refusal can be proposed back; anything unexpected is not a model error.
  if (outcome.status !== 'failed') throw err;
  return { rejected: true, toolName, outcome };
}

/** The catalogue tool, only if it is actually registered in the USER registry (AC-5 of spec 035). */
function registeredTool(name: string): CatalogTool<ToolInput, unknown> | undefined {
  const tool = findCatalogTool(name);
  return tool && findUserTool(name) === tool.definition ? tool : undefined;
}

/** Display rows + binding rows: exactly what spec 035's record stores and step 6 compares. */
async function boundParameters(
  tool: CatalogTool<ToolInput, unknown>,
  input: ToolInput,
  context: McpAuthContext,
): Promise<{ display: McpBoundParameter[]; bound: McpBoundParameter[] }> {
  const display = await tool.display!(input, context);
  if (display.some((row) => !tool.displayLabels.includes(row.label))) {
    throw new Error(`Tool "${tool.definition.name}" produced a display row it did not declare.`);
  }
  return { display, bound: [...display, ...encodeBinding(input, tool.fields)] };
}

function logToolCall(entry: { tool: string; status: AiActionOutcome['status']; errorCode: string | null; retry: boolean; auditId: string | null }): void {
  // Spec 036 §9: one structured event per attempt — never input values.
  console.info(JSON.stringify({ event: 'mcp_tools.tool_call', ...entry, at: new Date().toISOString() }));
}

export const MCP_TOOLS_EXECUTOR: AiActionExecutor = {
  async interpretTurn(ctx, output): Promise<AiProposedAction | AiRejectedToolCall | null> {
    const call = readToolCall(output);
    if (!call) return null;

    const toolName = typeof call.name === 'string' ? call.name : '';
    const context = await mcpAuthContextFor(ctx);
    const tool = registeredTool(toolName);
    if (!tool || !tool.definition.modes.includes(context.activeMode) || context.sessionId === '') {
      return rejected(toolName, mcpToolNotAvailableInContextError());
    }

    let input: ToolInput;
    try {
      input = tool.definition.validate(call.input);
    } catch (err) {
      return rejected(toolName, err);
    }

    const { definition } = tool;
    const related = tool.related?.(input) ?? null;
    const decision = decideRisk(definition.riskTier);
    if (decision.kind === 'refuse') return null;
    if (decision.kind === 'execute') {
      return { actionType: definition.name, actionLabel: definition.label, riskTier: definition.riskTier, parameters: [], related, input };
    }

    // Medium/high: the card is derived from live data; a domain refusal (not yours, not found) is
    // told back to the model instead of producing a card.
    let rows: { display: McpBoundParameter[]; bound: McpBoundParameter[] };
    try {
      rows = await boundParameters(tool, input, context);
    } catch (err) {
      return rejected(toolName, err);
    }
    const record = await createMcpConfirmation({
      userId: ctx.userId,
      toolName: definition.name,
      riskTier: decision.tier,
      parameters: rows.bound,
    });
    return {
      actionType: definition.name,
      actionLabel: definition.label,
      riskTier: definition.riskTier,
      parameters: rows.display,
      related,
      confirmationId: record.id,
      input,
    };
  },

  async resolveConfirmation(ctx, confirmationId): Promise<AiProposedAction | null> {
    const record = await readMcpConfirmation(confirmationId, ctx.userId);
    if (!record) return null;
    const tool = registeredTool(record.toolName);
    if (!tool) return null;

    // Resolved and, if stale, rejected BEFORE spec 034 records anything (spec 034 §3.4).
    if (record.consumedAt !== null || record.expiresAt.getTime() <= Date.now()) throw mcpConfirmationStaleError();

    const context = await mcpAuthContextFor(ctx);
    let input: ToolInput;
    try {
      input = tool.definition.validate(decodeBinding(record.parameters, tool.fields));
    } catch {
      throw mcpConfirmationStaleError();
    }
    const rows = await boundParameters(tool, input, context);
    if (!bindingMatches(record, rows.bound)) throw mcpConfirmationStaleError();

    return {
      actionType: tool.definition.name,
      actionLabel: tool.definition.label,
      riskTier: record.riskTier,
      parameters: rows.display,
      related: tool.related?.(input) ?? null,
      confirmationId: record.id,
      input,
    };
  },

  async execute(ctx, aiActionId, action): Promise<AiActionOutcome> {
    const tool = findCatalogTool(action.actionType);
    const input = (action.input ?? {}) as ToolInput;
    const baseContext = await mcpAuthContextFor(ctx);
    const idempotencyKey = tool?.stateChanging ? await idempotencyKeyForAction(aiActionId) : null;
    const context: McpAuthContext = {
      ...baseContext,
      ...(action.confirmationId ? { confirmationId: action.confirmationId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const inputParams = tool ? redactInput(input, tool.fields) : {};

    // Step 6 compares the parameters AS THEY STAND NOW: the display rows are re-derived from live
    // data, so a price or slot that moved since the user confirmed is a stale binding.
    let parameters: McpBoundParameter[] = action.parameters;
    let retriedFromCallId: string | null = null;
    for (let retries = 0; ; retries += 1) {
      const callId = await beginToolCall({ aiActionId, idempotencyKey, inputParams, retriedFromCallId });
      try {
        if (tool?.definition.requiresConfirmation) parameters = (await boundParameters(tool, input, context)).bound;
        const result = await authorizeAndExecute(
          { toolName: action.actionType, rawInput: input, parameters, surface: 'user' },
          context,
        );
        await completeToolCall(callId, { outputSummary: tool?.summarize(result.data, input) ?? null, errorCode: null });
        logToolCall({ tool: action.actionType, status: 'succeeded', errorCode: null, retry: retries > 0, auditId: result.auditId });
        return { status: 'succeeded', data: result.data };
      } catch (err) {
        if (shouldRetry(err, retries, tool?.definition.requiresConfirmation ?? true)) {
          await completeToolCall(callId, { outputSummary: null, errorCode: 'INTERNAL_ERROR' });
          logToolCall({ tool: action.actionType, status: 'unknown', errorCode: 'INTERNAL_ERROR', retry: retries > 0, auditId: null });
          retriedFromCallId = callId;
          continue;
        }
        const outcome = toOutcome(err);
        await completeToolCall(callId, { outputSummary: null, errorCode: outcome.error.code });
        logToolCall({ tool: action.actionType, status: outcome.status, errorCode: outcome.error.code, retry: retries > 0, auditId: null });
        if (!(err instanceof ApiRouteError) && outcome.status === 'unknown') {
          console.error(JSON.stringify({ event: 'mcp_tools.tool_call_failed', tool: action.actionType, error: String(err) }));
        }
        return outcome;
      }
    }
  },

  labelFor(actionType) {
    return findUserTool(actionType)?.label ?? null;
  },

  async catalogFor(ctx) {
    const context = await mcpAuthContextFor(ctx);
    if (context.sessionId === '') return [];
    return modelCatalogFor(context.activeMode);
  },
};
