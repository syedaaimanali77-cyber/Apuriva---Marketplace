import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listBookingEvidence } from '@/lib/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 028 §3, `GET /api/v1/bookings/{id}/evidence` — AC-8.
 *
 * METADATA ONLY. Bytes are reached exclusively through spec 027's `GET /api/v1/files/{id}`, which
 * re-runs the `booking_evidence` policy's `canRead` on every URL issue and every content fetch. So
 * this route cannot become a second, weaker read path: even if an id leaked from here, spec 027
 * would still refuse the fetch.
 *
 * The provider sees their booking's evidence at any time. The customer sees it only once the
 * booking has actually reached `completed` — before that they get an empty list rather than a
 * `403`, because the existence of evidence is itself information about a job still in progress.
 * There is deliberately no admin path here; spec 031 owns dispute access and registers its own
 * audited rule.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await listBookingEvidence(session.userId, bookingIdFromUrl(request, 1)), correlationId);
});
