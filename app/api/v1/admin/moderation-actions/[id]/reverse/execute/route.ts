import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { executeReversal } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 M6, `POST /api/v1/admin/moderation-actions/{id}/reverse/execute` — behind
 * `moderation/reverse`. Runs only after spec 009 confirms the reversal was approved by a second
 * admin, then restores the prior standing through §3.4. Idempotent by state.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  requireIdempotencyKey(request);
  const action = await executeReversal({ adminUserId: session.userId, actionId: pathId(request, 2), correlationId });
  return apiSuccess(action, correlationId);
});
