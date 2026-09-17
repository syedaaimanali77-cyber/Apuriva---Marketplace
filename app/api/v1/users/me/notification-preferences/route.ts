import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { getNotificationPreferences, updateNotificationPreferences } from '@/lib/notifications';

/** Spec 026 §3, `GET /api/v1/users/me/notification-preferences` — resolved defaults when no row exists. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await getNotificationPreferences(session.userId), correlationId);
});

/**
 * Spec 026 §3, `PATCH /api/v1/users/me/notification-preferences` (AC-2). Body `{ categories, version }`.
 * `400 VALIDATION_ERROR`, `422 CATEGORY_NOT_OVERRIDABLE` (nothing changed), `409 CONFLICT` on a stale version.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  return apiSuccess(await updateNotificationPreferences(session.userId, body), correlationId);
});
