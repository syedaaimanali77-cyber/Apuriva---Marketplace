/**
 * Spec 030 §3 "AI boundary" (AC-4) — an ADVISORY summary, and nothing else.
 *
 * MASTER §132.17 IS SATISFIED STRUCTURALLY, NOT BY POLICY TEXT. Look at what this module can do:
 * it takes a string, returns a string or `null`, and has no database access, no transaction, no
 * status argument and no return path into any decision. The enforcement and transition functions in
 * this spec take no AI-derived parameter, so there is no interface through which an AI verdict
 * could reach one even by mistake.
 *
 * It uses the EXISTING `summarization` task — already a member of `AI_TASKS` and already admitted
 * by `ai_usage_events_task_ck` — so no spec 033 migration is required and no new vocabulary is
 * invented here.
 *
 * DEGRADATION IS TOTAL AND SILENT. A disabled assistant, an outage, a rate limit, a quota, a
 * configuration error or any other throw all produce `null`, and the report is created and queued
 * exactly as it would have been. An AI outage must never block a safety submission or change a
 * triage outcome.
 */
import { completeAi, isAiDegradable } from '@/lib/ai';

/** Bounded so a long report cannot drive an unbounded prompt. */
const MAX_INPUT_CHARACTERS = 2000;
const MAX_SUMMARY_TOKENS = 200;

/**
 * Produces a short, advisory summary of a safety report's description for the admin queue.
 *
 * Returns `null` whenever AI is unavailable for ANY reason. The caller stores the result in
 * `safety_reports.ai_summary`, a column no decision ever reads.
 */
export async function summarizeForTriage(description: string): Promise<string | null> {
  const input = description.slice(0, MAX_INPUT_CHARACTERS);
  try {
    const result = await completeAi({
      task: 'summarization',
      input,
      // A platform-initiated call: there is no end user asking for this, and it must not consume
      // the reporter's quota for an assistance they never requested.
      subject: { kind: 'system', label: 'safety_triage_summary' },
      maxTokens: MAX_SUMMARY_TOKENS,
    });
    const output = result.output.trim();
    return output.length === 0 ? null : output;
  } catch (err) {
    // `isAiDegradable` covers the expected outage shapes; anything else is logged and degraded too,
    // because NO failure of an advisory feature may affect a safety report's handling.
    if (!isAiDegradable(err)) {
      console.error(JSON.stringify({ event: 'safety.ai_summary_failed', error: String(err) }));
    }
    return null;
  }
}
