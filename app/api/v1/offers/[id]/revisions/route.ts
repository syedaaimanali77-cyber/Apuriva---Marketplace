import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { reviseOffer } from '@/lib/negotiation/revise';
import { listRevisionChainForCustomer, listRevisionChainForProvider } from '@/lib/negotiation/revisions-read';
import { offerIdFromUrl } from '../../offer-id';

/**
 * Spec 019 §3, `POST /api/v1/offers/{id}/revisions` — the offer's provider sends a revised offer (AC-4,
 * AC-9, AC-13). Returns the NEW offer row, whose 2-minute window is database-computed; the source's window
 * is never touched. Requires `Idempotency-Key`; a replay returns the same new offer with `200`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { offer, replayed } = await reviseOffer(session.userId, profile.id, offerIdFromUrl(request, 1), idempotencyKey, body);
  return apiSuccess(offer, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * Spec 019 §3, `GET /api/v1/offers/{id}/revisions` — the revision chain containing `{id}`, for the request's
 * customer (customer mode) or the offer's provider (provider mode); anyone else gets `404 OFFER_NOT_FOUND`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const offerId = offerIdFromUrl(request, 1);
  if (session.activeMode === 'provider') {
    const profile = await requireOwnProviderProfile(session.userId);
    return apiSuccess(await listRevisionChainForProvider(profile.id, offerId), correlationId);
  }

  requireActiveMode(session, 'customer');
  return apiSuccess(await listRevisionChainForCustomer(session.userId, offerId), correlationId);
});
