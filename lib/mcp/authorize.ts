/**
 * Spec 035 §3 / AC-1, AC-2 — THE eight-step authorization pipeline (master spec §89).
 *
 * The order is fixed and every step blocks:
 *
 *   1. authenticated identity      5. tool risk
 *   2. current role/mode           6. required confirmation
 *   3. resource ownership          7. permission scope
 *   4. booking/request context     8. audit requirement
 *
 * Two invariants hold throughout:
 *
 *   - THE BACKEND IS AUTHORITATIVE (AC-2). Identity, mode and admin status come from the session
 *     the caller already validated, never from tool input and never from anything the model said.
 *     `requireExactFields` rejects an identity field outright, so a model that "believes" a
 *     booking belongs to the user cannot assert it — ownership is answered by the module that owns
 *     the row.
 *   - EVERY REFUSAL IS THE SAME TO THE CALLER. Which step failed is recorded server-side (audit +
 *     `mcp.authorization_failed`), never disclosed, so the pipeline is not an oracle for probing
 *     what someone else owns.
 *
 * Step 8 runs BEFORE execution: if the audit entry cannot be written, the tool does not run.
 */
import { decideRisk } from '@/lib/ai-assistant/risk-policy';
import { getMcpAuditSink } from './audit';
import { consumeMcpConfirmation, resolveMcpConfirmation } from './confirmation';
import {
  mcpAuthorizationFailedError,
  mcpToolNotAvailableInContextError,
  mcpConfirmationStaleError,
} from './errors';
import { resolveMcpToolPermission } from './permissions';
import { findAdminTool, findUserTool } from './registry';
import { logMcpAuthorizationFailure, logMcpSuspiciousPattern, type McpCheckName } from './security-log';
import type { McpAuthContext, McpBoundParameter, McpToolDefinition, McpToolResult } from './types';

/** The eight checks, in the order master spec §89 lists them. Exported so a test can assert it. */
export const MCP_AUTHORIZATION_CHECKS: readonly McpCheckName[] = [
  'authenticated_identity',
  'role_mode',
  'resource_ownership',
  'booking_request_context',
  'tool_risk',
  'required_confirmation',
  'permission_scope',
  'audit_requirement',
] as const;

export interface McpCallRequest {
  toolName: string;
  /** Raw, untrusted: whatever the model produced. Never read before the tool's `validate`. */
  rawInput: unknown;
  /**
   * The exact parameters this call is bound to, as the user saw them. Required for a tool that
   * needs confirmation — step 6 compares them with what was stored when the user approved (AC-3).
   */
  parameters?: McpBoundParameter[];
  /** Which registry to look in. A user conversation may only ever pass 'user' (AC-5). */
  surface?: 'user' | 'admin';
}

/** Records the refusal and throws. `error` lets a step choose a more specific code than 403. */
function refuse(
  check: McpCheckName,
  toolName: string,
  context: McpAuthContext,
  reason: string,
  error = mcpAuthorizationFailedError(),
): never {
  logMcpAuthorizationFailure({ toolName, check, userId: context.userId, reason });
  throw error;
}

/**
 * Runs the eight checks and, only if all eight pass, executes the tool.
 *
 * This is the ONLY way a tool runs. There is no second path, no "trusted" caller and no flag that
 * skips a step — spec 034's executor calls straight into here.
 */
export async function authorizeAndExecute<TOutput = unknown>(
  call: McpCallRequest,
  context: McpAuthContext,
): Promise<McpToolResult<TOutput>> {
  const surface = call.surface ?? 'user';

  // ---- Step 1: authenticated identity ------------------------------------------------------
  // The caller resolves the session (spec 005 `requireSession`); the pipeline refuses to run
  // without one rather than assuming a caller did its job.
  if (context.userId.trim().length === 0 || context.sessionId.trim().length === 0) {
    refuse('authenticated_identity', call.toolName, context, 'no authenticated session in context');
  }

  // Tool lookup. An admin tool is not in the user registry AT ALL (AC-5), so a user conversation
  // asking for one gets the same "unknown tool" as a typo — and the attempt is logged, because a
  // user-surface call naming an admin tool is a tampering signature, not a typo.
  const tool: McpToolDefinition<unknown, TOutput> | undefined =
    surface === 'admin' ? findAdminTool(call.toolName) : findUserTool(call.toolName);
  if (!tool) {
    if (surface === 'user' && findAdminTool(call.toolName)) {
      logMcpSuspiciousPattern({
        toolName: call.toolName,
        userId: context.userId,
        pattern: 'admin_tool_from_user_context',
        detail: 'an admin tool was requested from a user conversation',
      });
      refuse('role_mode', call.toolName, context, 'admin tool requested from a user surface', mcpToolNotAvailableInContextError());
    }
    logMcpSuspiciousPattern({
      toolName: call.toolName,
      userId: context.userId,
      pattern: 'unknown_tool',
      detail: `no such tool in the ${surface} registry`,
    });
    refuse('role_mode', call.toolName, context, 'unknown tool', mcpToolNotAvailableInContextError());
  }

  // ---- Step 2: current role/mode -----------------------------------------------------------
  if (tool.adminOnly && (surface !== 'admin' || !context.isAdmin)) {
    refuse('role_mode', tool.name, context, 'admin tool outside an admin context', mcpToolNotAvailableInContextError());
  }
  if (!tool.modes.includes(context.activeMode)) {
    refuse(
      'role_mode',
      tool.name,
      context,
      `tool is not available in ${context.activeMode} mode`,
      mcpToolNotAvailableInContextError(),
    );
  }

  // Strict schema. Runs here because every later step reads the validated input, and because an
  // identity field in the payload must be refused before anything acts on it (master spec §93).
  // `validate` throws MCP_SCHEMA_VALIDATION_FAILED itself; a tampering attempt is logged first.
  let input: unknown;
  try {
    input = tool.validate(call.rawInput);
  } catch (err) {
    if (identityFieldAttempt(call.rawInput)) {
      logMcpSuspiciousPattern({
        toolName: tool.name,
        userId: context.userId,
        pattern: 'identity_field_in_input',
        detail: 'tool input tried to supply caller identity',
      });
    }
    throw err;
  }

  // ---- Step 3: resource ownership ----------------------------------------------------------
  // Answered by the module that owns the row, never re-implemented here, and never taken from
  // what the model claims (AC-2).
  if (tool.checkOwnership) {
    const outcome = await tool.checkOwnership(input, context);
    if (!outcome.ok) refuse('resource_ownership', tool.name, context, outcome.reason ?? 'caller does not own the resource');
  }

  // ---- Step 4: booking/request context -----------------------------------------------------
  if (tool.checkContext) {
    const outcome = await tool.checkContext(input, context);
    if (!outcome.ok) refuse('booking_request_context', tool.name, context, outcome.reason ?? 'resource is not in a valid state');
  }

  // ---- Step 5: tool risk -------------------------------------------------------------------
  // Spec 034 owns the tier→decision mapping; `restricted` is refused before anything else looks
  // at it, and is never executed, offered or recorded.
  const decision = decideRisk(tool.riskTier);
  if (decision.kind === 'refuse') refuse('tool_risk', tool.name, context, 'restricted risk tier');

  // ---- Step 6: required confirmation -------------------------------------------------------
  const needsConfirmation = decision.kind === 'confirm';
  if (needsConfirmation) {
    const parameters = call.parameters ?? [];
    if (!context.confirmationId) refuse('required_confirmation', tool.name, context, 'no confirmation presented');

    const resolution = await resolveMcpConfirmation({
      confirmationId: context.confirmationId,
      userId: context.userId,
      toolName: tool.name,
      parameters,
    });
    if (!resolution.ok) {
      if (resolution.rejection === 'tool_mismatch') {
        logMcpSuspiciousPattern({
          toolName: tool.name,
          userId: context.userId,
          pattern: 'confirmation_mismatch',
          detail: 'a confirmation issued for another tool was presented',
        });
      }
      // A binding that changed, expired or was already used all mean the same thing to the user:
      // they must be asked again, against the parameters as they now stand (AC-3). A confirmation
      // that never existed is not disclosed as such — it refuses like any other check.
      const stale =
        resolution.rejection === 'parameters_changed' ||
        resolution.rejection === 'expired' ||
        resolution.rejection === 'consumed';
      refuse(
        'required_confirmation',
        tool.name,
        context,
        `confirmation rejected: ${resolution.rejection}`,
        stale ? mcpConfirmationStaleError() : mcpAuthorizationFailedError(),
      );
    }
  }

  // ---- Step 7: permission scope ------------------------------------------------------------
  // Spec 009's resolver for an admin tool. A user tool's scope is its mode and its ownership,
  // already established by steps 2 and 3 — there is no second, weaker notion of scope.
  if (tool.permission) {
    const allowed = await resolveMcpToolPermission(context.userId, tool.permission);
    if (!allowed) refuse('permission_scope', tool.name, context, 'permission not granted by any assigned role');
  }

  // ---- Step 8: audit requirement -----------------------------------------------------------
  // Before execution: an action that cannot be accounted for does not happen.
  let auditId: string;
  try {
    auditId = await getMcpAuditSink().record({
      toolName: tool.name,
      riskTier: tool.riskTier,
      userId: context.userId,
      sessionId: context.sessionId,
      confirmed: needsConfirmation,
      reversible: tool.reversible,
    });
  } catch {
    refuse('audit_requirement', tool.name, context, 'audit entry could not be recorded');
  }

  // One approval authorises exactly one execution.
  if (needsConfirmation && context.confirmationId) {
    const consumed = await consumeMcpConfirmation(context.confirmationId, context.userId);
    if (!consumed) refuse('required_confirmation', tool.name, context, 'confirmation was already used', mcpConfirmationStaleError());
  }

  // ---- All eight passed: execute -----------------------------------------------------------
  const data = await tool.execute(input, context);
  return { success: true, data, auditId };
}

/** Whether raw input tried to name the caller — used only to log, never to decide. */
function identityFieldAttempt(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const identity = ['userId', 'user_id', 'sessionId', 'session_id', 'isAdmin', 'is_admin', 'activeMode', 'active_mode'];
  return Object.keys(raw as Record<string, unknown>).some((key) => identity.includes(key));
}
