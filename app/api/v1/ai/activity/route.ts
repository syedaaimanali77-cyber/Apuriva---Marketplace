import { withApiRoute } from '@/lib/api/handler';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { listActivity } from '@/lib/ai-assistant';
import { enforceDefaultRateLimit } from '../ai-route-support';

/**
 * Spec 034 §3.2, `GET /api/v1/ai/activity` (AC-10, AC-11) — the caller's activity, newest first,
 * including actions taken in conversations they later deleted. Never a raw tool identifier.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceDefaultRateLimit(session.userId);

  const result = await listActivity(session.userId, parsePageParams(new URL(request.url).searchParams));
  return apiPaged(result.data, result.page, correlationId);
});
