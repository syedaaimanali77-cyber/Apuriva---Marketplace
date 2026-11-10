import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { listOffersForCustomer } from '@/lib/offers/read';
import { requestIdFromUrl } from '../../request-id';

/**
 * Spec 018 §3, `GET /api/v1/requests/{id}/offers` — every offer on the caller's own request, including
 * expired/declined/withdrawn/accepted ones (AC-4), newest first, with effective status (AC-3).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const result = await listOffersForCustomer(session.userId, requestIdFromUrl(request, 1), page);
  return apiPaged(result.data, result.page, correlationId);
});
