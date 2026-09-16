import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listReportsForBooking } from '@/lib/no-show';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 023 §3, `GET /api/v1/bookings/{id}/no-show-reports` — the participant view.
 *
 * Each party sees the neutral status of every report on their booking and whether a response has
 * been filed. Neither sees the other's statement, the evidence bundle, the location signal or any
 * admin field: that projection is `toParticipantDto`'s job, and the admin DTO is never reachable
 * from this route (AC-10).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const reports = await listReportsForBooking(session.userId, bookingIdFromUrl(request, 1));
  return apiSuccess(reports, correlationId);
});
