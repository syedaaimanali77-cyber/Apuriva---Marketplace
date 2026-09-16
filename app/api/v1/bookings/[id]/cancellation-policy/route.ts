import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { readBookingCancellationPolicy } from '@/lib/cancellation';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 023 §3, `GET /api/v1/bookings/{id}/cancellation-policy` — AC-1.
 *
 * The route AC-1's "sees the policy before paying" guarantee actually rests on: it returns the
 * version SNAPSHOTTED for this booking, never a re-resolution of current configuration, so an admin
 * publishing a new policy cannot change what an existing customer agreed to.
 *
 * Open to either participant in their own mode — a provider has as much right to know the terms of
 * a booking they are committed to as the customer does. A non-participant gets `404` from
 * `requireBookingParticipant`, never `403`, so booking ids cannot be probed.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const policy = await readBookingCancellationPolicy(session.userId, bookingIdFromUrl(request, 1));
  return apiSuccess(policy, correlationId);
});
