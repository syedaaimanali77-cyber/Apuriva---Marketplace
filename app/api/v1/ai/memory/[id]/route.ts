import { withApiRoute } from '@/lib/api/handler';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { deleteMemoryEntry } from '@/lib/ai-assistant';
import { aiIdFromUrl, enforceDefaultRateLimit, noContent } from '../../ai-route-support';

/** Spec 034 §3.9, `DELETE /api/v1/ai/memory/{id}` (AC-3) — one entry; not owned is `404`. */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  await deleteMemoryEntry(session.userId, aiIdFromUrl(request));
  return noContent(correlationId);
});
