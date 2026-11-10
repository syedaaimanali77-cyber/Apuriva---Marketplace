import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { answerCommonQuestion, parseAssistantRequest } from '@/lib/support';
import type { SupportAssistantAnswerDto } from '@/lib/types/support';

/**
 * Spec 032 §3 "AI boundary", `POST /api/v1/support/assistant` — AC-1.
 *
 * THIS ROUTE CAN NEVER STAND BETWEEN A USER AND A HUMAN. It returns `200` in EVERY branch —
 * success, a disabled assistant, a rate limit, an exhausted quota, a provider outage, a
 * misconfiguration, an arbitrary throw — always carrying `escalationAvailable: true`. An AI failure
 * is not the user's problem and must not look like a failed support request, still less block
 * reaching a person. `answerCommonQuestion` swallows every failure into `null`, and
 * `SupportAssistantAnswerDto.escalationAvailable` is typed as the literal `true`, so there is no
 * value this handler could return that withholds the escalation.
 *
 * IT USES SPEC 033's `ai` RATE-LIMIT DOMAIN, not `support`. Assistant traffic therefore cannot
 * consume the ticket surface's budget: someone who exhausts the assistant can still raise a ticket,
 * reply on one, and attach a file. This is the only route in the spec on a domain other than
 * `support`, and that is the reason.
 *
 * IT CREATES NOTHING, so it takes no `Idempotency-Key`. Nothing is stored either — no table, no
 * column, no log of the question or the answer. Spec 033's `ai_usage_events` accounts the call and,
 * by its own design, records neither.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  // A genuine rate limit on the AI domain IS a 429 — the caller really has exceeded a limit. This
  // is the one refusal this route makes, and it is about volume, never about AI availability.
  const limit = checkRateLimit('ai', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const { question } = parseAssistantRequest(body);

  const answer = await answerCommonQuestion(question, session.userId);

  const payload: SupportAssistantAnswerDto = {
    answer,
    available: answer !== null,
    escalationAvailable: true,
  };

  return apiSuccess(payload, correlationId);
});
