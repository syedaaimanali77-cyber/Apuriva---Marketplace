import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { decideAppeal, parseAppealDecisionRequest } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/admin/disputes/{id}/appeal-decision` — AC-4, AC-7.
 *
 * A DIFFERENT ADMIN FROM THE RESOLVER, ALWAYS. The caller's user id is compared to
 * `dispute_resolutions.resolved_by_admin_user_id`; equal is `403
 * APPEAL_REQUIRES_DIFFERENT_ADMIN`. This is the rule spec 009's `decideAction()` applies as
 * `SELF_APPROVAL_NOT_ALLOWED`, applied here to a decision spec 009 does not mediate. It also
 * requires `disputes/review_appeal`, a grant separate from `disputes/resolve` so an appeal reviewer
 * is an auditable, deliberate assignment.
 *
 * THE ORIGINAL RESOLUTION IS NEVER EDITED. `dispute_resolutions` is append-only; the outcome is
 * recorded on the appeal row and the pair is the history. An overturned decision is still a
 * decision somebody made, and erasing it would destroy the trail the appeal exists to create.
 *
 * THE DECISION IS FINAL — there is no appeal of an appeal — so this closes the dispute, which is
 * also where the money is handed back to spec 021. If a proposed refund has not completed, the
 * DECISION IS STILL RECORDED and closure defers to the sweep: a human's verdict must not be lost
 * because a payment provider is slow.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseAppealDecisionRequest(body);

  const appeal = await decideAppeal(disputeIdFromUrl(request, 1), session.userId, input, correlationId);
  return apiSuccess(appeal, correlationId);
});
