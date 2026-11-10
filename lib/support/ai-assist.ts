/**
 * Spec 032 §3 "AI boundary" (AC-1, DECIDED-2) — the ONLY two AI call sites in `lib/support/`.
 *
 * MASTER §62's "AI handles common questions" IS SATISFIED STRUCTURALLY, NOT BY POLICY TEXT. Look at
 * what this module can do: it takes strings, returns a string or `null`, and has NO database
 * access, NO transaction, NO ticket id, NO status argument, NO category argument and NO return path
 * into any decision. `createSupportTicket`, `assignTicket`, `setTicketPriority`, `resolveTicket`,
 * `handOffTicket` and every lifecycle function take NO AI-derived parameter, so there is no
 * interface through which an AI value could reach `category`, `priority`, `status`,
 * `assigned_admin_user_id`, `resolution_kind`, `handoff_target` or either escalation pointer — even
 * by mistake. `lib/support/ai-boundary.test.ts` asserts that at source level.
 *
 * IT USES EXISTING `AI_TASKS` MEMBERS ONLY — `conversation` and `summarization` are both already
 * admitted by `ai_usage_events_task_ck`, so no spec 033 migration is required and no vocabulary is
 * invented.
 *
 * DEGRADATION IS TOTAL. A disabled assistant, an outage, a rate limit, a quota, a configuration
 * error or any other throw all produce `null`. For the triage summary that is silent and the ticket
 * is unaffected. For the user-facing answer the route converts `null` into a `200` carrying
 * `escalationAvailable: true`, because an AI outage is not the user's problem and must never look
 * like a failed support request — still less block reaching a human.
 */
import { completeAi, isAiAssistantEnabled, isAiDegradable } from '@/lib/ai';

/** Bounded so a long ticket cannot drive an unbounded prompt. */
const MAX_INPUT_CHARACTERS = 4000;
const MAX_SUMMARY_TOKENS = 250;
const MAX_ANSWER_TOKENS = 400;

/**
 * CALL SITE 1 (AC-1) — a suggested answer to a common question, shown to the asking user.
 *
 * The subject is the USER: they asked for this, so it is their spec 033 quota that pays for it.
 * Nothing is stored — there is no table, no column and no log of either the question or the answer;
 * spec 033's `ai_usage_events` accounts the call and, by its own design, records neither.
 *
 * Returns `null` whenever AI is unavailable for ANY reason, including the assistant being switched
 * off entirely. The caller ALWAYS offers the human path regardless of what comes back.
 */
export async function answerCommonQuestion(question: string, userId: string): Promise<string | null> {
  // Checked first so a disabled assistant costs nothing and takes no quota.
  if (!isAiAssistantEnabled()) return null;

  const prompt = question.slice(0, MAX_INPUT_CHARACTERS);

  try {
    const result = await completeAi({
      task: 'conversation',
      input: prompt,
      subject: { kind: 'user', userId },
      maxTokens: MAX_ANSWER_TOKENS,
    });
    const output = result.output.trim();
    return output.length === 0 ? null : output;
  } catch (err) {
    // `isAiDegradable` covers the expected outage shapes — including rate limit and quota, which
    // must NOT surface as a 429 from a support route, because the user has exceeded no support
    // limit. Anything else is logged and degraded identically.
    if (!isAiDegradable(err)) {
      console.error(JSON.stringify({ event: 'support.ai_answer_failed', error: String(err) }));
    }
    return null;
  }
}

export interface SupportSummaryInput {
  subject: string;
  description: string;
  category: string;
  /** Message bodies, oldest first. Already normalized and contact-policy-processed. */
  messages?: readonly string[];
}

/**
 * CALL SITE 2 (AC-5) — a short, advisory brief for the admin queue.
 *
 * A `system` subject: this is platform-initiated, so it must NOT consume the requester's quota for
 * an assistance they never asked for. Spec 031's `summarizeForTriage` made the identical choice.
 *
 * The caller stores the result in `support_tickets.ai_summary`, a column no decision ever reads and
 * which never appears in a participant-facing DTO.
 */
export async function summarizeForTriage(input: SupportSummaryInput): Promise<string | null> {
  if (!isAiAssistantEnabled()) return null;

  const parts = [`Support category: ${input.category}`, `Subject: ${input.subject}`, `Description: ${input.description}`];
  if (input.messages && input.messages.length > 0) parts.push(`Thread:\n${input.messages.join('\n')}`);
  const prompt = parts.join('\n\n').slice(0, MAX_INPUT_CHARACTERS);

  try {
    const result = await completeAi({
      task: 'summarization',
      input: prompt,
      subject: { kind: 'system', label: 'support_triage_summary' },
      maxTokens: MAX_SUMMARY_TOKENS,
    });
    const output = result.output.trim();
    return output.length === 0 ? null : output;
  } catch (err) {
    if (!isAiDegradable(err)) {
      console.error(JSON.stringify({ event: 'support.ai_summary_failed', error: String(err) }));
    }
    return null;
  }
}
