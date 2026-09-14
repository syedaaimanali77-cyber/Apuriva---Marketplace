import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireBookingParticipant } from '@/lib/bookings';
import { bookingIdFromUrl } from '../booking-id';

/**
 * Spec 020 §3, `GET /api/v1/bookings/{id}` — either participant, in either active mode.
 *
 * A caller who is not a participant gets `404 BOOKING_NOT_FOUND`, never `403`, so booking ids
 * cannot be probed by observing a different status (§3 "Authorization matrix").
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const { booking } = await requireBookingParticipant(session.userId, bookingIdFromUrl(request));
  return apiSuccess(booking, correlationId);
});
