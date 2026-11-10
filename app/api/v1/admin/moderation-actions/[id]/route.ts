import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getModerationActionDetail } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 M3, `GET /api/v1/admin/moderation-actions/{id}` — behind `moderation/read`. Carries
 * the evidence file-asset ids (readable only through spec 027's routes), spec 009's approval chain
 * and the appeal, if any.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceModerationRateLimit(session.userId);
  return apiSuccess(await getModerationActionDetail(session.userId, pathId(request), correlationId), correlationId);
});
