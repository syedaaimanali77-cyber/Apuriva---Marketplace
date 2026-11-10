import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { getOfferComparison } from '@/lib/negotiation/compare';
import { requestIdFromUrl } from '../../../request-id';

/**
 * Spec 019 §3, `GET /api/v1/requests/{id}/offers/compare[?offerIds=a,b,c]` — 2–3 live offers side by side
 * with Top Match and rule-based reasons (AC-2, AC-6, AC-10, AC-11). An unavailable comparison is `200`
 * with `available: false`, never an error. No admin-only matching data is returned.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const offerIds = new URL(request.url).searchParams.get('offerIds');
  return apiSuccess(await getOfferComparison(session.userId, requestIdFromUrl(request, 2), offerIds), correlationId);
});
