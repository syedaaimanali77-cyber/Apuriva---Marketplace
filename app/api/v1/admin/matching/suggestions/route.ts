import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listMatchingSuggestions } from '@/lib/matching/admin';

/**
 * Spec 017 §3 AC-7, `GET /api/v1/admin/matching/suggestions` — every recorded AI-proposed
 * ranking-weight change, for admin review. Mirrors spec 010's already-shipped
 * `GET /admin/catalog/pending-review`, one instance of the same review-workflow pattern rather
 * than a new one.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listMatchingSuggestions(session.userId, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
