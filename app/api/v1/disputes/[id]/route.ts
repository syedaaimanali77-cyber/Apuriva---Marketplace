import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getDisputeForParticipant } from '@/lib/disputes';
import { disputeIdFromUrl } from '../dispute-id';

/**
 * Spec 031 §3, `GET /api/v1/disputes/{id}` — the participant's view (AC-3, DECIDED-10).
 *
 * WHAT IT CARRIES: the status, the reason, both sides' evidence and message counts, the resolution
 * WITH ITS REASONING (master §2.3 — the reasoning, not just the outcome), any appeal, the appeal
 * deadline, and this caller's own capabilities.
 *
 * WHAT IT CANNOT CARRY, structurally: the counterparty's user id, any admin identity, the advisory
 * AI summary, the refund approval chain, the safety cross-reference or the legal-hold flag.
 * `DisputeDto` has no field for any of them and `PARTICIPANT_COLUMNS` never selects them, so this
 * is not a runtime filter that could be forgotten.
 *
 * Anyone who is not a participant gets `404`, never `403` — including an admin, who has their own
 * route. `403` would confirm that two other people are arguing about a booking.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dispute = await getDisputeForParticipant(disputeIdFromUrl(request), session.userId);
  return apiSuccess(dispute, correlationId);
});
