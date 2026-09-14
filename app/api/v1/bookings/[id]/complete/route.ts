import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { completeBooking } from '@/lib/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 020 §3, `POST /api/v1/bookings/{id}/complete` — AC-5, AC-8, AC-9, AC-10, AC-11.
 *
 * AC-8, unchanged: **either** the customer **or** the provider may mark an `in_progress` booking
 * complete, with equal authority and **without the other party's confirmation**. This route asks
 * for no agreement, waits for nothing, and has no confirmation parameter.
 *
 * It is the one route open to either active mode. The mode selects which participant the caller is
 * acting as, and `completeBooking` requires the caller genuinely to be that party — so a user who
 * holds both a customer and a provider profile on one booking can never write an ambiguous
 * `actor_role` (§3 "Authorization matrix").
 *
 * Validation order is normative (AC-9) and starts here: (1) session, (2) CSRF, then (3) participant
 * + mode match, (4) `Idempotency-Key`, (5) status, (6) dwell, (7) evidence gate, (8) the
 * concurrency-safe transition — the last five inside `completeBooking`. A request failing any of
 * (1)–(7) is rejected on its own merits even if the other party's concurrent request already
 * completed the booking.
 *
 * The body carries **no** evidence field: evidence storage is spec 027's and the requirement is
 * spec 028's (§3 "Completion-evidence gate"). Spec 028 extends this body when it ships.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  // Required so a retried completion is a replay, never a second attribution (safeguard S9).
  requireIdempotencyKey(request);

  const booking = await completeBooking(session.userId, bookingIdFromUrl(request, 1), mode);
  return apiSuccess(booking, correlationId);
});
