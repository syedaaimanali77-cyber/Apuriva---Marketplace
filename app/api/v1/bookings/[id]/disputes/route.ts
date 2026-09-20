import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireBookingParticipant } from '@/lib/bookings';
import { openDispute, parseOpenDisputeRequest } from '@/lib/disputes';

/**
 * Spec 031 §3, `POST /api/v1/bookings/{id}/disputes` — AC-1, AC-2.
 *
 * EITHER PARTICIPANT, EITHER MODE. `requireBookingParticipant` is the gate, and it already answers
 * `404` rather than `403` to a non-participant, so a dispute cannot be used to probe whether a
 * booking exists. No `requireActiveMode` call: a disagreement is not role-scoped, and forcing a
 * customer who happens to be in provider mode to switch before they can dispute a job is a barrier
 * at exactly the wrong moment.
 *
 * ELIGIBILITY IS NOT CHECKED HERE. `openDispute` evaluates it under the booking and payment row
 * locks, because the answer depends on state spec 021's sweep may be changing concurrently. A
 * check in the route would be a read of a value that could be stale by the time the insert happens.
 *
 * One call does three things atomically: creates the dispute, moves the booking
 * `protected -> disputed`, and moves the payment protection `held -> disputed` — which is the whole
 * of AC-2's payout hold.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const bookingId = decodeURIComponent(segments[segments.length - 2] ?? '');

  // `404` for a non-participant, before anything else is read.
  await requireBookingParticipant(session.userId, bookingId);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseOpenDisputeRequest(body);

  const { dispute, replayed } = await openDispute(session.userId, bookingId, input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(dispute, correlationId, { status: replayed ? 200 : 201 });
});
