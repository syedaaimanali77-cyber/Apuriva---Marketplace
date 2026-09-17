import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { markConversationRead } from '@/lib/messaging';
import { bookingIdFromUrl } from '../../../booking-id';

/**
 * Spec 025 §3, `POST /api/v1/bookings/{id}/conversation/read` — advances the caller's `last_read_at`
 * monotonically, so a stale client can never move it backwards. Naturally idempotent: no
 * `Idempotency-Key`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const state = await markConversationRead(session, bookingIdFromUrl(request, 2), body);
  return apiSuccess(state, correlationId);
});
