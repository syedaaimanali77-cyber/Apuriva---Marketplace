import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { readServiceCancellationPolicy } from '@/lib/cancellation';

function serviceIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 023 §3, `GET /api/v1/services/{id}/cancellation-policy` — AC-1.
 *
 * Guest-readable, like the service detail page it appears on: a customer must be able to see the
 * policy BEFORE committing to anything, which includes before signing in. Rate limited on spec
 * 004's existing `bookings` domain, keyed by user id when there is a session and by client IP
 * otherwise, so an unauthenticated caller cannot use it as an unbounded read.
 *
 * This returns the policy effective NOW. Once a booking exists, the authoritative read is the
 * booking-scoped route, which returns that booking's immutable snapshot instead.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous');

  const limit = checkRateLimit('bookings', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const policy = await readServiceCancellationPolicy(serviceIdFromUrl(request));
  return apiSuccess(policy, correlationId);
});
