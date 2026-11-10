import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { createBooking, isBookingListFilter, listBookings } from '@/lib/bookings';

/**
 * Spec 020 §3, `POST /api/v1/bookings` — AC-1, AC-3, AC-12.
 *
 * Deliberately a thin transport wrapper: session, CSRF, active mode, rate limit and the
 * `Idempotency-Key` header are transport concerns, and **every** domain rule — the ordered
 * revalidation, the lock order, the slot reservation, the price copy, the transition — lives in
 * `createBooking`. That is what makes §3's MCP requirement true: spec 036's `create_booking` tool
 * calls the same function and inherits every guarantee, because there is nothing extra here to miss.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { booking, created } = await createBooking(session.userId, idempotencyKey, body);
  // §3 Idempotency: a replay returns the original booking with `200`, never a second `201`.
  return apiSuccess(booking, correlationId, { status: created ? 201 : 200 });
});

/**
 * Spec 020 §3, `GET /api/v1/bookings` — the caller's own bookings only.
 *
 * The ACTIVE MODE selects the role (§3 "Authorization matrix"); it is never inferred and never
 * taken from the client, so a customer can never page through a provider's bookings or vice versa.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const rawFilter = url.searchParams.get('filter');
  const filter = isBookingListFilter(rawFilter) ? rawFilter : undefined;
  const page = parsePageParams(url.searchParams);

  const result = await listBookings(session.userId, mode, { filter, ...page });
  return apiPaged(result.data, buildPage(result.total, page.limit, page.offset), correlationId);
});
