/**
 * Spec 031 §3 "AI boundary" (AC-6, DECIDED-8) — an ADVISORY summary, and nothing else.
 *
 * MASTER §132.17 AND §2097 ("Restricted — Human/admin: … Serious disputes") ARE SATISFIED
 * STRUCTURALLY, NOT BY POLICY TEXT. Look at what this module can do: it takes strings, returns a
 * string or `null`, and has no database access, no transaction, no status argument, no amount
 * argument and no return path into any decision. `resolveDispute`, `decideAppeal`, `closeDispute`
 * and `linkRefundApproval` take NO AI-derived parameter, so there is no interface through which an
 * AI verdict could reach one even by mistake — which is what `lib/disputes/ai-boundary.test.ts`
 * asserts at source level.
 *
 * It uses the EXISTING `summarization` task — already a member of `AI_TASKS` and already admitted
 * by `ai_usage_events_task_ck` — so no spec 033 migration is required and no vocabulary is invented.
 *
 * DEGRADATION IS TOTAL AND SILENT. A disabled assistant, an outage, a rate limit, a quota, a
 * configuration error or any other throw all produce `null`, and the dispute is opened, resolved,
 * appealed and closed exactly as it would have been. An AI outage must never block a dispute or
 * change an outcome.
 */
import { completeAi, isAiDegradable } from '@/lib/ai';

/** Bounded so a long dispute cannot drive an unbounded prompt. */
const MAX_INPUT_CHARACTERS = 4000;
const MAX_SUMMARY_TOKENS = 250;

export interface DisputeSummaryInput {
  reason: string;
  /** Message bodies, oldest first. Already normalized and contact-policy-processed by spec 025's rule. */
  messages?: readonly string[];
  /** Evidence descriptors — kind and filename only, never bytes and never a signed URL. */
  evidence?: readonly string[];
}

/**
 * Produces a short, advisory brief of a dispute for the Trust & Safety queue.
 *
 * Returns `null` whenever AI is unavailable for ANY reason. The caller stores the result in
 * `disputes.ai_summary`, a column no decision ever reads and which never appears in a
 * participant-facing DTO.
 */
export async function summarizeForTriage(input: DisputeSummaryInput): Promise<string | null> {
  const parts = [`Dispute reason: ${input.reason}`];
  if (input.evidence && input.evidence.length > 0) parts.push(`Evidence: ${input.evidence.join('; ')}`);
  if (input.messages && input.messages.length > 0) parts.push(`Thread:\n${input.messages.join('\n')}`);
  const prompt = parts.join('\n\n').slice(0, MAX_INPUT_CHARACTERS);

  try {
    const result = await completeAi({
      task: 'summarization',
      input: prompt,
      // A platform-initiated call: no end user asked for this, and it must not consume a
      // participant's quota for an assistance they never requested.
      subject: { kind: 'system', label: 'dispute_triage_summary' },
      maxTokens: MAX_SUMMARY_TOKENS,
    });
    const output = result.output.trim();
    return output.length === 0 ? null : output;
  } catch (err) {
    // `isAiDegradable` covers the expected outage shapes; anything else is logged and degraded too,
    // because NO failure of an advisory feature may affect how a dispute is handled.
    if (!isAiDegradable(err)) {
      console.error(JSON.stringify({ event: 'disputes.ai_summary_failed', error: String(err) }));
    }
    return null;
  }
}
