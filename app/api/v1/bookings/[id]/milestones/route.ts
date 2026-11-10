import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { createBookingMilestone, listBookingMilestones, parseMilestoneRequest } from '@/lib/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 028 §3, `POST /api/v1/bookings/{id}/milestones` — AC-3, AC-10.
 *
 * The booking's own provider only: provider mode plus `requireOwnProviderProfile`, so no provider
 * id ever comes from the client. A customer calling it gets `404`, indistinguishable from a booking
 * that does not exist.
 *
 * THIS ROUTE CHANGES NO BOOKING STATUS (AC-3). It posts content and returns it; it performs no
 * transition, and a booking can reach `completed` having never seen one. It also accepts no location
 * signal of any kind — no coordinate, geofence or telemetry field exists in its body, so there is no
 * interface here through which such a signal could move the state machine (AC-9).
 *
 * `Idempotency-Key` is REQUIRED, unlike spec 020's naturally-idempotent lifecycle routes: repeating
 * this POST would otherwise append a second visible row rather than replay the first. The key is
 * unique PER BOOKING at the database, never globally.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  const profile = await requireOwnProviderProfile(session.userId);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  // Validated BEFORE fingerprinting, so the fingerprint is taken over normalized values and a retry
  // differing only in whitespace replays rather than conflicting.
  const input = parseMilestoneRequest(body);

  const { milestone, replayed } = await createBookingMilestone(
    session.userId,
    profile.id,
    bookingIdFromUrl(request, 1),
    input,
    { key, fingerprint: idempotencyFingerprint(input) },
  );

  return apiSuccess(milestone, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * Spec 028 §3, `GET /api/v1/bookings/{id}/milestones` — either participant, either mode.
 *
 * A milestone exists to be seen by the customer, so both parties read the same list in `createdAt`
 * order. It carries no `createdByUserId`: a counterparty user id never reaches a client (spec 020
 * §4), and both parties already know the poster is the booking's provider.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await listBookingMilestones(session.userId, bookingIdFromUrl(request, 1)), correlationId);
});
