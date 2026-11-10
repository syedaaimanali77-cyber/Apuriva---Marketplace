import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { declineOffer } from '@/lib/offers/decide';
import { offerIdFromUrl } from '../../offer-id';

/** Spec 018 §3, `POST /api/v1/offers/{id}/decline` — the request's owner (AC-8). Repeating returns `200`. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await declineOffer(session.userId, offerIdFromUrl(request, 1)), correlationId);
});
