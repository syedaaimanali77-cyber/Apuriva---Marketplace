import { withApiRoute } from '@/lib/api/handler';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { deleteConversation } from '@/lib/ai-assistant';
import { aiIdFromUrl, enforceDefaultRateLimit, noContent } from '../../ai-route-support';

/**
 * Spec 034 §3.2, `DELETE /api/v1/ai/conversations/{id}` (AC-8). Missing, deleted or not owned is the
 * same `404`. Messages are hard-deleted, the conversation tombstoned; activity and memory remain.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  await deleteConversation(session.userId, aiIdFromUrl(request));
  return noContent(correlationId);
});
