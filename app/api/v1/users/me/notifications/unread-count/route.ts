import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { countUnreadNotifications } from '@/lib/notifications';

/** Spec 026 §3, `GET /api/v1/users/me/notifications/unread-count` — the badge, without paging the inbox. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess({ unread: await countUnreadNotifications(session.userId) }, correlationId);
});
