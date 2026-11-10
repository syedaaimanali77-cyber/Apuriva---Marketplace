import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { linkRefundApproval, parseLinkRefundRequest } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/admin/disputes/{id}/link-refund` — added during the Prompt-1 review
 * (DECIDED-11).
 *
 * WHY IT EXISTS. A resolution proposes an amount; spec 022's `POST /api/v1/admin/refunds` returns
 * an `adminActionId` when Finance initiates the override. Without a route to record that id,
 * nothing connects the proposal to the refund that satisfies it: `refundState` could never leave
 * `proposed`, and closure could never tell "Finance has not acted" from "the refund completed".
 *
 * IT STORES AN APPROVAL-CHAIN ID, NOT A REFUND ID. No `refunds` row exists at this point — spec 022
 * creates one only after a second admin approves. The concrete refund is discovered later by
 * joining `refunds ON refunds.admin_action_id = dispute_resolutions.refund_admin_action_id`, an
 * existing indexed column. No column is added to `refunds`.
 *
 * DUPLICATE REFUND REQUESTS ARE IMPOSSIBLE: the conditional `WHERE refund_admin_action_id IS NULL`
 * means a resolution links to at most one approval chain, so a second Finance admin initiating a
 * second override cannot attach it to the same dispute. Re-linking the SAME id is idempotent.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseLinkRefundRequest(body);

  const resolution = await linkRefundApproval(disputeIdFromUrl(request, 1), session.userId, input, correlationId);
  return apiSuccess(resolution, correlationId);
});
