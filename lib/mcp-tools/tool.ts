/**
 * Spec 036 §3 — how a catalogue tool is declared. Every tool is a spec 035 `McpToolDefinition`,
 * used as shipped, plus the catalogue metadata this spec owns: its field declaration, the
 * plain-language display rows of its confirmation card, its output summary and its related entity.
 *
 * The builder is what makes three rules structural rather than per-tool discipline:
 *   - `requiresConfirmation` is DERIVED from spec 034's mapping, never restated by hand;
 *   - `validate` is DERIVED from the field declaration (strict; spec 035 §3);
 *   - a state-changing tool's `execute` refuses, with `MCP_IDEMPOTENCY_KEY_REQUIRED`, unless the
 *     server issued a key (§3 "Idempotency") — the domain function is then never called.
 */
import { requiresConfirmation, type AiProposedRiskTier } from '@/lib/ai-assistant/risk-policy';
import type { McpAuthContext, McpBoundParameter, McpCheckOutcome, McpToolDefinition } from '@/lib/mcp';
import type { ActiveMode } from '@/lib/types/users';
import { McpIdempotencyKeyRequiredError } from './errors';
import { validateToolInput, type ToolField } from './fields';
import type { ToolOutputSummary } from './recorder';

export type ToolInput = Record<string, unknown>;

export interface CatalogTool<TInput extends ToolInput = ToolInput, TOutput = unknown> {
  definition: McpToolDefinition<TInput, TOutput>;
  fields: readonly ToolField[];
  /** Whether the tool changes state — and therefore needs a server-generated idempotency key. */
  stateChanging: boolean;
  /**
   * Confirmable tools only: the labels their card shows (master spec §90, without Location), declared
   * statically so registration can prove none collides with an input field name (§3 contract 1).
   */
  displayLabels: readonly string[];
  /** Confirmable tools only: the card's plain-language rows, derived server-side from LIVE data. */
  display?(input: TInput, context: McpAuthContext): Promise<McpBoundParameter[]>;
  /** §4 `output_summary` — the resulting resource's type, id and status, or null when there is none. */
  summarize(output: TOutput, input: TInput): ToolOutputSummary | null;
  /** The entity an activity entry links to, when it is known before execution. */
  related?(input: TInput): { type: 'request' | 'booking'; id: string } | null;
}

export interface ToolSpec<TInput extends ToolInput, TOutput> {
  name: string;
  label: string;
  riskTier: Exclude<AiProposedRiskTier, 'restricted'>;
  reversible: boolean;
  modes: readonly ActiveMode[];
  stateChanging: boolean;
  fields: readonly ToolField[];
  displayLabels?: readonly string[];
  checkOwnership?(input: TInput, context: McpAuthContext): Promise<McpCheckOutcome>;
  run(input: TInput, context: McpAuthContext, idempotencyKey: string | null): Promise<TOutput>;
  display?(input: TInput, context: McpAuthContext): Promise<McpBoundParameter[]>;
  summarize(output: TOutput, input: TInput): ToolOutputSummary | null;
  related?(input: TInput): { type: 'request' | 'booking'; id: string } | null;
}

export function defineTool<TInput extends ToolInput, TOutput>(spec: ToolSpec<TInput, TOutput>): CatalogTool<TInput, TOutput> {
  const definition: McpToolDefinition<TInput, TOutput> = {
    name: spec.name,
    riskTier: spec.riskTier,
    label: spec.label,
    reversible: spec.reversible,
    adminOnly: false,
    modes: spec.modes,
    requiresConfirmation: requiresConfirmation(spec.riskTier),
    isIdempotent: spec.stateChanging,
    validate: (raw) => validateToolInput(raw, spec.fields) as TInput,
    ...(spec.checkOwnership ? { checkOwnership: spec.checkOwnership } : {}),
    async execute(input, context) {
      if (!spec.stateChanging) return spec.run(input, context, null);
      if (!context.idempotencyKey) throw new McpIdempotencyKeyRequiredError(spec.name);
      return spec.run(input, context, context.idempotencyKey);
    },
  };

  return {
    definition,
    fields: spec.fields,
    stateChanging: spec.stateChanging,
    displayLabels: spec.displayLabels ?? [],
    ...(spec.display ? { display: spec.display } : {}),
    summarize: spec.summarize,
    ...(spec.related ? { related: spec.related } : {}),
  };
}

/** Ownership answered by the owning module: its own "not found" becomes a refusal, never a leak. */
export async function ownedBy(check: () => Promise<unknown>): Promise<McpCheckOutcome> {
  try {
    await check();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'the owning module does not recognise the caller as its owner' };
  }
}
