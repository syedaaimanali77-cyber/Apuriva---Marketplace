/**
 * AI abstraction boundary — spec 033 establishes `lib/ai` as the module every AI-consuming spec
 * (013, 034, 035/036) builds against, never a direct vendor call. Spec 033/034's full AI-assistant
 * architecture (conversation memory, autonomy tiers, MCP tools) is NOT implemented here — this is
 * only the minimum interface spec 013's `/search/interpret` needs: turn free text into a raw,
 * unresolved set of search signals. It never resolves a `serviceId` (that's an authoritative DB
 * lookup, `lib/search/interpret.ts`'s job) and never returns search results itself (AC-1) —
 * mirroring the same swappable-adapter pattern as `lib/auth/oauth-provider.ts`,
 * `lib/auth/sms-otp-provider.ts`, and `lib/location/provider.ts`. Only a sandbox/rule-based
 * implementation ships until a real AI provider is wired up (spec 033 §8, unresolved), per master
 * spec §133.7.
 */
export interface RawSearchIntent {
  serviceNameRaw?: string;
  area?: string;
  date?: string;
  budgetMaxMinorUnits?: number;
  currencyCode?: string;
}

export interface AiIntentInterpreter {
  /** Extracts raw, unresolved signals from free text (typed or voice-transcribed — this
   * interface has no notion of "voice" at all, so neither can ever be given elevated trust,
   * spec 013 AC-5). Never throws for ordinary text; an empty/unresolvable input just yields an
   * empty `RawSearchIntent`. */
  interpret(text: string): Promise<RawSearchIntent>;
}

const BUDGET_PATTERN = /(?:under|below|less than|<=?)\s*(?:rs\.?|pkr)?\s*([\d,]+)/i;
const AREA_PATTERN = /\b(?:in|around|near)\s+([a-z][a-z\s]{1,40}?)(?=[,.]|$|\s+(?:tomorrow|today|under|below|for))/i;
const DATE_KEYWORDS: Record<string, string> = { today: 'today', tomorrow: 'tomorrow', tonight: 'today' };

/**
 * Rule-based sandbox implementation: no external vendor call, deterministic, good enough to
 * exercise the `/search/interpret` contract (confidence scoring, low-confidence fallback) in
 * tests and local dev without an AI provider. A real provider (spec 033 §8) implements the same
 * interface later without changing any caller.
 */
class SandboxIntentInterpreter implements AiIntentInterpreter {
  async interpret(text: string): Promise<RawSearchIntent> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return {};

    const result: RawSearchIntent = {};

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
}

const sandboxInterpreter = new SandboxIntentInterpreter();

/** Only the sandbox is wired up for now (spec 033 §8) — swap this factory when a real AI
 * provider ships. */
export function getIntentInterpreter(): AiIntentInterpreter {
  return sandboxInterpreter;
}
