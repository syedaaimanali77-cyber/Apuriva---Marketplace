import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { listIncomingRequests } from '@/lib/matching/provider-requests';

/**
 * Spec 017 §3, `GET /api/v1/providers/me/requests` — the caller's own incoming-request inbox:
 * only requests this provider was actually distributed into (`notified_at` set), never every
 * eligible/ranked request. The provider id is resolved from the session, never from the client,
 * the same ownership pattern `requireOwnProviderProfile` established in spec 016.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listIncomingRequests(profile.id, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
