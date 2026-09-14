import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { withdrawOffer } from '@/lib/offers/decide';
import { offerIdFromUrl } from '../../offer-id';

/** Spec 018 §3, `POST /api/v1/offers/{id}/withdraw` — the offer's own provider, before expiry (AC-8). */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  return apiSuccess(await withdrawOffer(session.userId, profile.id, offerIdFromUrl(request, 1)), correlationId);
});
