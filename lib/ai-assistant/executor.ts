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
}

export interface AiActionExecutor {
  /** After `completeAi`, normal turns only: at most ONE proposed action per turn. */
  interpretTurn(ctx: AiActionContext, output: string): Promise<AiProposedAction | null>;
  /**
   * `POST …/confirm`: resolves spec 035's confirmation record. `null` → `404`. A stale confirmation
   * throws spec 035's own error, which the route passes through unchanged (§3.5).
   */
  resolveConfirmation(ctx: AiActionContext, confirmationId: string): Promise<AiProposedAction | null>;
  /** Runs an already risk-checked action. Only the result it confirms moves the row off `pending`. */
  execute(ctx: AiActionContext, aiActionId: string, action: AiProposedAction): Promise<{ succeeded: boolean }>;
  /** The plain-language label for a recorded `action_type`; `null` → not shown in activity (§8 risk 6). */
  labelFor(actionType: string): string | null;
}

/** The pre-035/036 default: no tools, so nothing to propose, confirm, execute or label. */
const INERT_EXECUTOR: AiActionExecutor = {
  interpretTurn: async () => null,
  resolveConfirmation: async () => null,
  execute: async () => {
    throw new Error('No AI action executor is registered (specs 035/036).');
  },
  labelFor: () => null,
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
