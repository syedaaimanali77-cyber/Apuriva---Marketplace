import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { executeModerationAction } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 M4, `POST /api/v1/admin/moderation-actions/{id}/execute` — behind the action's
 * per-type permission. Calls spec 009's `executeApprovedAction()` FIRST (`422 APPROVAL_REQUIRED`
 * while pending, `409 APPROVAL_NOT_ELIGIBLE` once rejected), then applies the effect through its
 * owner. The body carries no effect parameters. Idempotent by state: a second call is `409`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  requireIdempotencyKey(request);
  const action = await executeModerationAction({ adminUserId: session.userId, actionId: pathId(request, 1), correlationId });
  return apiSuccess(action, correlationId);
});
