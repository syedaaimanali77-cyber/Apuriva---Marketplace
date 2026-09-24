/**
 * Spec 034 §3.4 — the `AiActionExecutor` PORT, shipped INERT.
 *
 * Every AI action goes AI → MCP → backend authorization → execution (master spec §87). MCP tools
 * are specs 035/036, sequenced AFTER this spec, so this spec executes nothing itself and invents no
 * private execution path. Specs 035/036 register a real executor from `instrumentation.ts` — the
 * pattern of spec 021's `DisputeGate`, spec 027's file contexts and spec 030's
 * `ConversationBlockGate`.
 *
 * Ownership (§3.4): 035/036 interpret the model's tool requests, run the eight-step authorization,
 * own the confirmation record (binding, expiry, staleness) and tool-call idempotency. This spec
 * owns the risk decision (`risk-policy.ts`), presenting and accepting confirmations, and recording
 * `ai_actions`.
 *
 * With the inert default the assistant proposes no actions, no confirmation can be pending, and
 * `POST …/confirm` is `404` for every id — the honest behaviour of a surface with no tools yet
 * (master spec §132.8).
 *
 * The executor is invoked ONLY from a normal conversation turn and from `POST …/confirm` — never by
 * a temporary turn, the suggestion endpoint or the memory route (§3.4, §3.11).
 */
import type { AiProposedRiskTier } from './risk-policy';

export interface AiActionContext {
  userId: string;
  sessionId: string;
  /** Always a STORED conversation. A temporary conversation has no id and so no context. */
  conversationId: string;
}

export interface AiProposedAction {
  /** Spec 035's tool name. Stored in `ai_actions.action_type`; never sent to a client (§85). */
  actionType: string;
  /** Plain language, e.g. "Book AC repair with Ali Raza" — never a raw tool identifier. */
  actionLabel: string;
  riskTier: AiProposedRiskTier;
  /** The exact parameters a confirmation is bound to (§90), in display order. */
  parameters: Array<{ label: string; value: string }>;
  related: { type: 'request' | 'booking'; id: string } | null;
  /** Issued by spec 035's confirmation record; present only for medium/high proposals. */
  confirmationId?: string;
  /**
   * Spec 036 §3 execution contract 1: the tool input exactly as the tool's strict `validate`
   * returned it. SERVER-ONLY — never copied into any client DTO (`pendingConfirmation` is built from
   * named fields). For a confirmed action it is restored from spec 035's stored binding, never
   * re-supplied by the model or the client.
   */
  input?: Record<string, unknown>;
}

/**
 * Spec 036 §3 execution contract 3 — what running an action actually produced. Only `succeeded`
 * can be read as success (master spec §92, §132.8):
 *   - `failed`  — a CONFIRMED failure (a domain error, a spec 035 pipeline error, or spec 036's
 *                 `MCP_IDEMPOTENCY_KEY_REQUIRED`), its `code`/`message`/`details` unchanged;
 *   - `unknown` — any other failure; for a state-changing tool the effect may or may not have
 *                 committed, so the row stays `pending` ("outcome unknown").
 */
export type AiActionOutcome =
  | { status: 'succeeded'; data: unknown }
  | { status: 'failed'; error: { code: string; message: string; details?: Record<string, unknown>; retryable: false } }
  | { status: 'unknown'; error: { code: 'INTERNAL_ERROR'; message: string; retryable: false } };

/**
 * A tool call the model requested that cannot even be proposed — an unknown or unavailable tool, or
 * input that fails the tool's strict schema. Nothing is executed or recorded; the failure is fed
 * back to the model so its reply explains it rather than implying an action happened.
 */
export interface AiRejectedToolCall {
  rejected: true;
  toolName: string;
  outcome: Extract<AiActionOutcome, { status: 'failed' }>;
}

/** One tool as the model sees it (spec 036 §3 "Model-facing catalogue"): no logic, no admin tool. */
export interface AiModelTool {
  name: string;
  label: string;
  input: Array<{ name: string; kind: string; required: boolean; values?: readonly string[] }>;
}

export function isRejectedToolCall(value: AiProposedAction | AiRejectedToolCall | null): value is AiRejectedToolCall {
  return value !== null && 'rejected' in value && value.rejected === true;
}

export interface AiActionExecutor {
  /** After `completeAi`, normal turns only: at most ONE proposed (or rejected) tool call per turn. */
  interpretTurn(ctx: AiActionContext, output: string): Promise<AiProposedAction | AiRejectedToolCall | null>;
  /**
   * `POST …/confirm`: resolves spec 035's confirmation record. `null` → `404`. A stale confirmation
   * throws spec 035's own error, which the route passes through unchanged (§3.5).
   */
  resolveConfirmation(ctx: AiActionContext, confirmationId: string): Promise<AiProposedAction | null>;
  /**
   * Runs an already risk-checked action and returns its REAL outcome (spec 036 §3). Only a
   * `succeeded` outcome moves the row to `succeeded`; `unknown` leaves it `pending`.
   */
  execute(ctx: AiActionContext, aiActionId: string, action: AiProposedAction): Promise<AiActionOutcome>;
  /** The plain-language label for a recorded `action_type`; `null` → not shown in activity (§8 risk 6). */
  labelFor(actionType: string): string | null;
  /** The tools the model may request in this caller's current mode, added to the turn's input as data. */
  catalogFor(ctx: AiActionContext): Promise<AiModelTool[]>;
}

/** The pre-035/036 default: no tools, so nothing to propose, confirm, execute or label. */
const INERT_EXECUTOR: AiActionExecutor = {
  interpretTurn: async () => null,
  resolveConfirmation: async () => null,
  execute: async () => {
    throw new Error('No AI action executor is registered (specs 035/036).');
  },
  labelFor: () => null,
  catalogFor: async () => [],
};

let currentExecutor: AiActionExecutor = INERT_EXECUTOR;

/** Called once by specs 035/036 at startup to make the port real. */
export function registerAiActionExecutor(executor: AiActionExecutor): void {
  currentExecutor = executor;
}

export function getAiActionExecutor(): AiActionExecutor {
  return currentExecutor;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetAiActionExecutor(): void {
  currentExecutor = INERT_EXECUTOR;
}
