import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { previewCancellation } from '@/lib/cancellation';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 023 §3, `GET /api/v1/bookings/{id}/cancel-preview` — AC-3.
 *
 * The read-only dry run master spec §38 requires ("check any financial consequence; show consequence
 * before confirmation"), implemented the way spec 015 already implements it for requests
 * (`GET /requests/{id}/cancel-preview`) rather than by a second code path: the SAME
 * `computeCancellationConsequence` produces this number and the executed one.
 *
 * No CSRF, because a GET changes nothing the caller could be tricked into. It does materialise the
 * booking's policy snapshot if it has none yet — a write, but an idempotent one that only records
 * what was already true of the booking from the moment it was created.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const preview = await previewCancellation(session.userId, bookingIdFromUrl(request, 1));
  return apiSuccess(preview, correlationId);
});
