import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { createChangeRequest } from '@/lib/negotiation/change-requests';
import { offerIdFromUrl } from '../../offer-id';

/**
 * Spec 019 §3, `POST /api/v1/offers/{id}/change-requests` — the request's customer asks for a change
 * (AC-3). Records a thread row; never alters the offer's price, status, timer or version. Requires
 * `Idempotency-Key`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('offers', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { message, replayed } = await createChangeRequest(session.userId, offerIdFromUrl(request, 1), idempotencyKey, body);
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});
