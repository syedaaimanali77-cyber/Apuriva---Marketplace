import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { getDisputeForParticipant, waiveAppeal } from '@/lib/disputes';
import { disputeRefundPendingError } from '@/lib/disputes/errors';
import { disputeIdFromUrl } from '../../dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/disputes/{id}/waive-appeal` — added during the Prompt-1 review
 * (DECIDED-11).
 *
 * WHY IT EXISTS. Without it, closure depends solely on the appeal-expiry sweep, so a party who
 * reads the decision and accepts it still has the provider's money held for the rest of the window
 * — up to seven days of nothing happening for no reason. This lets them end it immediately.
 *
 * WAIVING IS ONE-SIDED ON PURPOSE. Whoever waives gives up only their OWN right to appeal. Because
 * at most one appeal exists per dispute, a waiver by either party while none is filed makes the
 * decision final, which is the honest reading of "I accept this".
 *
 * It is idempotent by nature rather than by key comparison: closing an already-`closed` dispute
 * returns `not_closeable` and this route simply answers with the current dispute. The
 * `Idempotency-Key` header is still required, for uniformity with every other state-changing POST
 * in this spec.
 *
 * A proposed refund that has not completed defers closure: `422 DISPUTE_REFUND_PENDING`, because a
 * dispute must never close having promised money nobody has sent.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const outcome = await waiveAppeal(disputeId, session.userId, correlationId);

  if (!outcome.closed && outcome.reason === 'refund_pending') {
    throw disputeRefundPendingError(outcome.refundState ?? 'proposed');
  }

  return apiSuccess(await getDisputeForParticipant(disputeId, session.userId), correlationId);
});
