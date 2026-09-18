/**
 * Spec 013's search-intent interpreter, now built on spec 033's abstraction.
 *
 * Its EXPORTED CONTRACT IS UNCHANGED — `AiIntentInterpreter`, `RawSearchIntent` and
 * `getIntentInterpreter()` are exactly what spec 013 shipped, and `lib/ai/intent-interpreter.test.ts`
 * passes unmodified; that test is the regression gate (spec 033 §3.10). What changed is only the
 * plumbing: the rule-based extraction moved verbatim into the sandbox adapter's `search_intent`
 * handler (`lib/ai/provider/sandbox.ts`), and the completion now comes through `completeAi()`, so
 * this path is rate-limited, quota-capped, cached and cost-accounted like every other AI call.
 *
 * It still never resolves a `serviceId` (that is an authoritative DB lookup, `lib/search/interpret.ts`'s
 * job) and never returns search results itself (spec 013 AC-1). It has no notion of "voice" at all,
 * so a transcription cannot be given elevated trust by construction (spec 013 AC-5).
 */
import { completeAi } from './complete';
import { isAiDegradable } from './errors';
import type { AiSubject } from './types';

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
   * spec 013 AC-5). Never throws for ordinary text; an empty/unresolvable input, a rate-limited
   * or quota-capped caller, and an unavailable provider all yield an empty `RawSearchIntent`,
   * which spec 013's route already surfaces as its documented low-confidence fallback
   * (spec 033 §3.9). `subject` attributes the call for rate limiting, quota and abuse
   * accounting; it defaults to a platform-internal caller. */
  interpret(text: string, subject?: AiSubject): Promise<RawSearchIntent>;
}

const DEFAULT_SUBJECT: AiSubject = { kind: 'system', label: 'search_intent' };

class AiSearchIntentInterpreter implements AiIntentInterpreter {
  async interpret(text: string, subject: AiSubject = DEFAULT_SUBJECT): Promise<RawSearchIntent> {
    // Blank input is input validation, not a question worth asking a provider — short-circuited
    // here so it spends no quota. The adapter returns `{}` for it too.
    if (text.trim().length === 0) return {};

    try {
      const result = await completeAi({ task: 'search_intent', input: text, subject });
      return parseIntent(result.output);
    } catch (err) {
      if (isAiDegradable(err)) return {};
      throw err;
    }
  }
}

/** A provider returns text; an unparseable or non-object answer is treated as "nothing extracted"
 * rather than an error, so a malformed completion degrades exactly like an unavailable one. */
function parseIntent(output: string): RawSearchIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const candidate = parsed as Record<string, unknown>;
  const intent: RawSearchIntent = {};
  if (typeof candidate.serviceNameRaw === 'string') intent.serviceNameRaw = candidate.serviceNameRaw;
  if (typeof candidate.area === 'string') intent.area = candidate.area;
  if (typeof candidate.date === 'string') intent.date = candidate.date;
  if (typeof candidate.budgetMaxMinorUnits === 'number' && Number.isFinite(candidate.budgetMaxMinorUnits)) {
    intent.budgetMaxMinorUnits = candidate.budgetMaxMinorUnits;
  }
  if (typeof candidate.currencyCode === 'string') intent.currencyCode = candidate.currencyCode;
  return intent;
}

const interpreter = new AiSearchIntentInterpreter();

export function getIntentInterpreter(): AiIntentInterpreter {
  return interpreter;
}
