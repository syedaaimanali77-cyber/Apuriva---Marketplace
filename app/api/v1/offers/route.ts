import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { createOffer } from '@/lib/offers/create';

/**
 * Spec 018 §3, `POST /api/v1/offers` — a distributed provider sends an offer (AC-5, AC-7, AC-9).
 * `Idempotency-Key` is required; a replay returns the original offer with `200`, never a second `201`.
 * `sentAt`/`expiresAt` are database-computed; no field of the body can influence them.
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

  const { offer, replayed } = await createOffer(session.userId, profile.id, idempotencyKey, body);
  return apiSuccess(offer, correlationId, { status: replayed ? 200 : 201 });
});
