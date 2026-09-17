import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getConversation } from '@/lib/messaging';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 025 §3, `GET /api/v1/bookings/{id}/conversation` — either participant, in their own active mode.
 * Creates the conversation on first access (idempotent, AC-7). A non-participant gets
 * `404 CONVERSATION_NOT_FOUND`, never `403`, so conversation existence cannot be probed.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const conversation = await getConversation(session, bookingIdFromUrl(request, 1));
  return apiSuccess(conversation, correlationId);
});
