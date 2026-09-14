import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { loadBookingStatusHistory, requireBookingParticipant } from '@/lib/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 020 §3, `GET /api/v1/bookings/{id}/status-history` — either participant, either mode.
 *
 * This is where AC-8/AC-10's "who performed it" is read from: the `in_progress -> completed` row's
 * `actorRole`. `actor_user_id` is never returned (§4) — a counterparty's user id never reaches a
 * client. Safeguard S7 depends on this endpoint: a completion is never silent, because the other
 * party can always see it and who did it.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const bookingId = bookingIdFromUrl(request, 1);
  await requireBookingParticipant(session.userId, bookingId);
  return apiSuccess(await loadBookingStatusHistory(bookingId), correlationId);
});
