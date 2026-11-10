import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listDisputesForUser } from '@/lib/disputes';

/**
 * Spec 031 §3, `GET /api/v1/disputes` — the caller's own disputes, newest first.
 *
 * ADDED DURING THE PROMPT-1 REVIEW (DECIDED-11). The draft had no way for a participant to find a
 * dispute except by already knowing its id, which the booking UI cannot assume.
 *
 * Scoped by JOIN, not by filter: the query only ever returns rows whose booking has this user as
 * its customer or provider, so there is no code path that could widen it. The summary shape carries
 * no reason, no decision and no identities — the detail route applies the full privacy projection.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listDisputesForUser(session.userId, page);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
