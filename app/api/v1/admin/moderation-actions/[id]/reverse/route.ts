import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseReasonOnly, requestReversal } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 M5, `POST /api/v1/admin/moderation-actions/{id}/reverse` — behind
 * `moderation/reverse` (`high`). Always four-eyes: creates a `Pending` spec 009 `AdminAction`
 * awaiting a second admin and returns `202`; nothing is reversed yet. One open reversal per action.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  requireIdempotencyKey(request);
  const { reason } = parseReasonOnly(await request.json().catch(() => ({})));
  const action = await requestReversal({ adminUserId: session.userId, actionId: pathId(request, 1), reason, correlationId });
  return apiSuccess(action, correlationId, { status: 202 });
});
