import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getHomeFeed } from '@/lib/home/feed';

/**
 * Spec 014 §3, `GET /api/v1/home` — session or guest. Shape varies by auth state (§2 scope note:
 * this is the customer-mode home feed; provider/admin get their own Dashboard/Overview, out of
 * this spec's scope per §7).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('home', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const feed = await getHomeFeed(session);
  return apiSuccess(feed, correlationId);
});
