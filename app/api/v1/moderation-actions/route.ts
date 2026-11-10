import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listMyModerationActions } from '@/lib/moderation';
import { enforceModerationRateLimit } from './moderation-route';

/**
 * Spec 038 §3.13 U1, `GET /api/v1/moderation-actions` — the caller's OWN moderation actions.
 *
 * ON THE §3.5 ALLOW-LIST (`allowModeratedAccount: true`): a suspended or banned user must still be
 * able to see what happened and appeal it. Never returns a pending or rejected action, and never the
 * internal reason, the evidence, the origin or which admin acted.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowModeratedAccount: true });
  enforceModerationRateLimit(session.userId);
  const page = parsePageParams(new URL(request.url).searchParams);
  const { rows, total } = await listMyModerationActions(session.userId, page);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
