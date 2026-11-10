import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { decideModerationAppeal, parseDecideAppealRequest } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 A2, `POST /api/v1/admin/moderation-appeals/{id}/decide` — behind
 * `moderation/review_appeal`, and never by the admin who initiated or approved the appealed action
 * (`403 APPEAL_REQUIRES_DIFFERENT_ADMIN`). `upheld` reverses the action through §3.4 in the same
 * transaction as the decision. Conditional on the appeal still being `pending`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  requireIdempotencyKey(request);
  const input = parseDecideAppealRequest(await request.json().catch(() => ({})));
  const appeal = await decideModerationAppeal({
    adminUserId: session.userId,
    appealId: pathId(request, 1),
    decision: input.decision,
    reason: input.reason,
    correlationId,
  });
  return apiSuccess(appeal, correlationId);
});
