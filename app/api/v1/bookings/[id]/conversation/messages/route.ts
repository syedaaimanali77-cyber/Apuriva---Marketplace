import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { listMessagesForParticipant, sendMessage } from '@/lib/messaging';
import { bookingIdFromUrl } from '../../../booking-id';

/**
 * Spec 025 §3, `GET /api/v1/bookings/{id}/conversation/messages` — the paged history (`limit`/`offset`)
 * or, with `after=<createdAtISO>|<id>`, the delta read the 5-second poller uses. Readable in every
 * booking status and while blocked (master spec §53).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const result = await listMessagesForParticipant(session, bookingIdFromUrl(request, 2), new URL(request.url).searchParams);
  return apiPaged(result.data, result.page, correlationId);
});

/**
 * Spec 025 §3, `POST /api/v1/bookings/{id}/conversation/messages` (AC-1, AC-2, AC-6, AC-8). Requires
 * `Idempotency-Key`; a replay returns the original message with `200`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { message, replayed } = await sendMessage(session, bookingIdFromUrl(request, 2), idempotencyKey, body);
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});
