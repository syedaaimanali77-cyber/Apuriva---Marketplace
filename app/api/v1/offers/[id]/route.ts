import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { getOfferForCustomer, getOfferForProvider } from '@/lib/offers/read';
import { offerIdFromUrl } from '../offer-id';

/**
 * Spec 018 §3, `GET /api/v1/offers/{id}` — the owning customer (customer mode) or the owning provider
 * (provider mode). Anyone else gets `404 OFFER_NOT_FOUND`, so offer ids cannot be probed. Terminal offers
 * stay readable (AC-4); the status is the effective one (AC-3).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const offerId = offerIdFromUrl(request);
  if (session.activeMode === 'provider') {
    const profile = await requireOwnProviderProfile(session.userId);
    return apiSuccess(await getOfferForProvider(profile.id, offerId), correlationId);
  }

  requireActiveMode(session, 'customer');
  return apiSuccess(await getOfferForCustomer(session.userId, offerId), correlationId);
});
