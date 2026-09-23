/**
 * Spec 035 §3 — the MCP tool contract. This is the ONLY shape a tool may take.
 *
 * Runtime and transport (spec 035 §3, decided): tools are invoked IN-PROCESS through spec 034's
 * existing `AiActionExecutor` port. No MCP SDK, no external transport, no new dependency. "MCP"
 * names master spec §88–§90's tool/authorization architecture here, not a wire protocol.
 *
 * Risk tiers are spec 034's `AiProposedRiskTier`, reused verbatim — never a second risk scale, and
 * never spec 009's admin `RiskTier` (`low|medium|high|critical`), which governs admin permissions
 * and means something else entirely.
 */
import type { AiProposedRiskTier } from '@/lib/ai-assistant/risk-policy';
import type { ActiveMode } from '@/lib/types/users';

/**
 * One parameter a confirmation is bound to (master spec §90: provider, service, date/time,
 * location, price, currency). Both halves are display strings: the binding is compared as the user
 * saw it, so a change in any of them is a change the user did not approve (AC-3).
 */
export interface McpBoundParameter {
  label: string;
  value: string;
}

/**
 * The authorization context a tool runs under. Every field is derived SERVER-SIDE by the caller
 * from the real session (spec 005 `requireSession`, spec 006 `sessions.active_mode`) — never from
 * model output, and never from tool input. AC-2: the AI is not the security boundary, so nothing
 * the model says can construct or alter this.
 */
export interface McpAuthContext {
  userId: string;
  activeMode: ActiveMode;
  isAdmin: boolean;
  sessionId: string;
  /** Present only after the user explicitly confirmed a medium/high action (spec 034 §3.4). */
  confirmationId?: string;
}

export interface McpToolResult<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  auditId: string;
}

/** What check 3 and check 4 return. A refusal carries its own reason for the audit trail. */
export interface McpCheckOutcome {
  ok: boolean;
  reason?: string;
}

/**
 * Spec 035 §3. `validate` is the strict schema (no schema library exists in this repository):
 * it returns the typed input or throws `MCP_SCHEMA_VALIDATION_FAILED` with spec 004's
 * field-level `errors[]`. Unexpected fields are REJECTED, never ignored (master spec §93).
 *
 * `checkOwnership` and `checkContext` are how checks 3 and 4 reach the owning domain module: the
 * pipeline never re-implements an ownership rule, it asks the module that owns it (spec 035 §3,
 * "the owning domain module's own query — never a re-implementation"). A tool that touches no
 * resource omits them, and the pipeline records them as not applicable rather than as passed.
 */
export interface McpToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Small and domain-specific, e.g. "create_service_request" — never a catch-all name (§88). */
  name: string;
  riskTier: AiProposedRiskTier;
  /** Plain language for spec 034's activity history, e.g. "Book AC repair" (master spec §85). */
  label: string;
  /** Whether the effect can be undone (master spec §86). */
  reversible: boolean;
  /** Admin tools live in a separate registry and are unreachable from a user conversation (AC-5). */
  adminOnly: boolean;
  /** The modes this tool may run in (check 2). Both, unless the tool is mode-specific. */
  modes: readonly ActiveMode[];
  /** Spec 009 `(resource, action)` for check 7. Required for an admin tool; user tools omit it. */
  permission?: { resource: string; action: string };
  requiresConfirmation: boolean;
  /** Declaration only — the key mechanics are spec 036's (spec 035 §7). */
  isIdempotent: boolean;
  validate(raw: unknown): TInput;
  checkOwnership?(input: TInput, context: McpAuthContext): Promise<McpCheckOutcome>;
  checkContext?(input: TInput, context: McpAuthContext): Promise<McpCheckOutcome>;
  execute(input: TInput, context: McpAuthContext): Promise<TOutput>;
}

/**
 * What `GET /api/v1/admin/mcp/tools` returns. Metadata only — never a tool's input or output.
 * Defined in `lib/types/mcp.ts` so the client page can import it without reaching into `lib/mcp`.
 */
export type { McpToolMetadataDto } from '@/lib/types/mcp';
