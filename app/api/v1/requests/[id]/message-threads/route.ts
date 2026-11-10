import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { listCustomerThreads } from '@/lib/negotiation/messages';
import { requestIdFromUrl } from '../../request-id';

/**
 * Spec 019 §3, `GET /api/v1/requests/{id}/message-threads` — the request's customer sees only threads with
 * providers who have an offer on the request or have already posted (never spec 017's distribution pool).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const result = await listCustomerThreads(session.userId, requestIdFromUrl(request, 1), page);
  return apiPaged(result.data, result.page, correlationId);
});
