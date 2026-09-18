/**
 * Spec 033 §8 risk 1 — the documented mock adapter (master spec §133.7). No external vendor call,
 * no credential, fully deterministic, and `isSandbox: true` so `resolveAiProvider` refuses it
 * under `NODE_ENV=production` (AC-2). It CLAIMS NO MODEL CAPABILITY: master spec §132.21 forbids
 * building a fake "working" integration, so every task but `search_intent` returns an explicitly
 * marked placeholder rather than pretending to have reasoned about the input.
 *
 * `search_intent` is the exception because it is not a model capability at all: the rule-based
 * extraction below is spec 013's own, moved here VERBATIM from `lib/ai/intent-interpreter.ts`
 * (spec 033 §3.10) so spec 013's shipped behaviour is preserved bit for bit. Its unmodified test
 * file is the regression gate.
 */
import type { AiTask } from '../types';
import type { AiProviderAdapter, AiProviderCompletion } from './types';

const BUDGET_PATTERN = /(?:under|below|less than|<=?)\s*(?:rs\.?|pkr)?\s*([\d,]+)/i;
const AREA_PATTERN = /\b(?:in|around|near)\s+([a-z][a-z\s]{1,40}?)(?=[,.]|$|\s+(?:tomorrow|today|under|below|for))/i;
const DATE_KEYWORDS: Record<string, string> = { today: 'today', tomorrow: 'tomorrow', tonight: 'today' };

/** The raw, unresolved signals `search_intent` yields. Serialised as the adapter's `output`, the
 * same shape a real provider would be prompted to return. It never resolves a `serviceId` — that
 * is an authoritative DB lookup, `lib/search/interpret.ts`'s job. */
export interface SandboxSearchIntent {
  serviceNameRaw?: string;
  area?: string;
  date?: string;
  budgetMaxMinorUnits?: number;
  currencyCode?: string;
}

export function extractSearchIntent(text: string): SandboxSearchIntent {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};

  const result: SandboxSearchIntent = {};

  const budgetMatch = BUDGET_PATTERN.exec(trimmed);
  if (budgetMatch) {
    const amount = Number(budgetMatch[1]!.replace(/,/g, ''));
    if (Number.isFinite(amount)) {
      result.budgetMaxMinorUnits = Math.round(amount * 100);
      result.currencyCode = 'PKR';
    }
  }

  for (const [keyword, value] of Object.entries(DATE_KEYWORDS)) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(trimmed)) {
      result.date = value;
      break;
    }
  }

  const areaMatch = AREA_PATTERN.exec(trimmed);
  if (areaMatch) result.area = areaMatch[1]!.trim();

  // Whatever's left after stripping the recognized fragments is the best-effort service-name
  // guess — a plain heuristic, not an authoritative match (that happens against real `services`
  // rows in lib/search/interpret.ts).
  const withoutKnownFragments = trimmed
    .replace(BUDGET_PATTERN, '')
    .replace(AREA_PATTERN, '')
    .replace(/\b(?:need|want|looking for|tomorrow|today|tonight|preferably|a|an)\b/gi, '')
    .replace(/[.,]/g, '')
    .trim();
  if (withoutKnownFragments.length > 0) result.serviceNameRaw = withoutKnownFragments;

  return result;
}

/** The marker every non-`search_intent` sandbox output carries, so a placeholder can never be
 * mistaken for a real completion by a consumer, a test, or a person reading a screen. */
export const SANDBOX_AI_OUTPUT_PREFIX = '[sandbox-ai: no model configured]';

/** Deterministic token estimate — roughly four characters per token, the usual rule of thumb,
 * bounded by the caller's clamped `maxTokens`. Deterministic so quota and cost assertions are
 * exact; it is an estimate, and a real adapter reports the provider's own count instead. */
function estimateTokens(input: string, output: string, maxTokens: number): number {
  return Math.min(maxTokens, Math.max(1, Math.ceil((input.length + output.length) / 4)));
}

class SandboxAiProvider implements AiProviderAdapter {
  readonly name = 'sandbox';
  readonly model = 'rule-based';
  readonly isSandbox = true;
  /** Bump when any rule above changes: the cache key embeds it, so old entries are stranded
   * rather than reused across a prompt change (spec 033 §3.8). */
  readonly promptVersion = 'v1';

  async complete(request: { task: AiTask; input: string; maxTokens: number }): Promise<AiProviderCompletion> {
    const output =
      request.task === 'search_intent'
        ? JSON.stringify(extractSearchIntent(request.input))
        : `${SANDBOX_AI_OUTPUT_PREFIX} task=${request.task}`;
    return { output, tokensUsed: estimateTokens(request.input, output, request.maxTokens) };
  }
}

const sandboxProvider = new SandboxAiProvider();

export function getSandboxAiProvider(): AiProviderAdapter {
  return sandboxProvider;
}
