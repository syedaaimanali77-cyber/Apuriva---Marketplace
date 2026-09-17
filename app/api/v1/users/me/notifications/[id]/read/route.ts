import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { markNotificationRead } from '@/lib/notifications';

/**
 * Spec 026 §3, `POST /api/v1/users/me/notifications/{id}/read` (AC-9). Idempotent: a second call returns
 * `200` with the same `readAt`. Another user's id is `404 NOTIFICATION_NOT_FOUND`, never `403`.
 * `withApiRoute` forwards no route context, so `{id}` is read from the URL.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const notificationId = decodeURIComponent(segments[segments.length - 2] ?? '');
  return apiSuccess(await markNotificationRead(session.userId, notificationId), correlationId);
});
