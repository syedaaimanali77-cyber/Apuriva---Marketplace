import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { createReview, getBookingReviewState, parseCreateReviewRequest } from '@/lib/reviews';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 029 §3, `POST /api/v1/bookings/{id}/reviews` — AC-1, AC-2, AC-4, AC-5, AC-7.
 *
 * The booking's own customer only: customer mode plus a server-side ownership join in
 * `resolveReviewEligibility`. A provider or a stranger calling it gets `404`, indistinguishable from
 * a booking that does not exist.
 *
 * NO PROVIDER, SERVICE, CUSTOMER OR AUTHOR ID IS ACCEPTED FROM THE BODY. Every one of those is
 * copied from the booking row inside the creating transaction, so this route has no interface
 * through which a caller could attribute a review to a different provider (AC-2).
 *
 * THIS ROUTE READS NO PAYMENT STATE (AC-1). Eligibility is the `in_progress -> completed` history
 * row and the review window, nothing else — so a refunded or disputed booking that genuinely
 * completed is still reviewable, and the protection window is never a lever on what a customer may
 * say.
 *
 * `Idempotency-Key` is REQUIRED: repeating this POST would otherwise race
 * `reviews_booking_id_uq` and surface as a `409` on an honest client retry.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  // Validated BEFORE fingerprinting, so the fingerprint is taken over normalized values and a retry
  // differing only in whitespace replays rather than conflicting.
  const input = parseCreateReviewRequest(body);

  const { review, replayed } = await createReview(session.userId, bookingIdFromUrl(request, 1), input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(review, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * Spec 029 §3, `GET /api/v1/bookings/{id}/reviews` — either participant, either mode.
 *
 * The SERVER-AUTHORITATIVE eligibility answer. A client must never compute the review deadline
 * itself (architecture §5.4), so `windowClosesAt` is derived here from the booking's own completion
 * history against the database clock, and the UI renders exactly what it is told.
 *
 * The provider is a legitimate caller: they see the review left about them, with
 * `eligible: false, reason: 'not_customer'` — the truth, rather than a `403` that would imply they
 * had merely asked in the wrong way.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await getBookingReviewState(session.userId, bookingIdFromUrl(request, 1)), correlationId);
});
