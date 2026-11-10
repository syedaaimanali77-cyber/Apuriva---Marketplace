import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { resolveLocaleForRequest } from '@/lib/i18n/server';
import { listNotifications } from '@/lib/notifications';

/**
 * Spec 026 §3, `GET /api/v1/users/me/notifications` (AC-8) — the caller's own notifications, ordered
 * `created_at DESC, id DESC`, paged by spec 004's `parsePageParams`/`buildPage`, optionally `?unreadOnly=true`.
 * User-level, not mode-scoped: one inbox across customer and provider mode, so no `requireActiveMode`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowModeratedAccount: true }); // spec 038 §3.5 allow-list

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const searchParams = new URL(request.url).searchParams;
  const page = parsePageParams(searchParams);
  const { locale } = await resolveLocaleForRequest(request, session.userId); // spec 042 §3.8: the reader's locale
  const { items, total } = await listNotifications(session.userId, page, {
    unreadOnly: searchParams.get('unreadOnly') === 'true',
    locale,
  });
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
