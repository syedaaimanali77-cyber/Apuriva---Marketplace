import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { acceptOffer } from '@/lib/offers/decide';
import { offerIdFromUrl } from '../../offer-id';

/**
 * Spec 018 §3, `POST /api/v1/offers/{id}/accept` — the request's owner (AC-1, AC-2, AC-6). Requires
 * `Idempotency-Key`. The decision is made by the database clock read after the row locks are held; the
 * browser countdown plays no part. Creates no booking (spec 020's `POST /api/v1/bookings`).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  return apiSuccess(await acceptOffer(session.userId, offerIdFromUrl(request, 1), idempotencyKey), correlationId);
});
