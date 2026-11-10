import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { advanceBooking } from '@/lib/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 020 §3, `POST /api/v1/bookings/{id}/start-service` — AC-4, AC-7, AC-11.
 *
 * The booking's own provider only: provider mode plus `requireOwnProviderProfile`, so no provider
 * id ever comes from the client. Naturally idempotent — repeating it when the booking is already
 * `in_progress` returns `200` with the current booking, which is why this route needs no
 * `Idempotency-Key`. An explicit authenticated action is the ONLY way this transition happens:
 * no timer, cron, webhook or location signal can perform it (AC-7).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  const profile = await requireOwnProviderProfile(session.userId);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const booking = await advanceBooking(session.userId, profile.id, bookingIdFromUrl(request, 1), 'in_progress');
  return apiSuccess(booking, correlationId);
});
