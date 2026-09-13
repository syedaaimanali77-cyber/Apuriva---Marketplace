import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { rejectMatchingSuggestion } from '@/lib/matching/admin';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 017 §3 AC-7, `POST /api/v1/admin/matching/suggestions/{id}/reject` — records the rejection;
 * publishes nothing. `409 SUGGESTION_ALREADY_REVIEWED` if no longer `pending_review`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dto = await rejectMatchingSuggestion(session.userId, idFromUrl(request));
  return apiSuccess(dto, correlationId);
});
