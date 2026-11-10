import { withApiRoute } from '@/lib/api/handler';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { apiPaged } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getOperationsQueue, logServed } from '@/lib/admin-dashboard';

/**
 * Spec 037 §3, `GET /api/v1/admin/operations/queue?limit&offset` — AC-2, AC-6.
 *
 * Any spec 009 admin role; each source (disputes, support tickets, safety reports) only for a
 * caller holding that source's existing read permission. Priority descending, then oldest first;
 * the repository's `limit`/`offset` paging. Read-only.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const startedAt = Date.now();
  const session = await requireSession(request);
  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await getOperationsQueue(session.userId, page);
  logServed('admin_dashboard.queue_served', correlationId, startedAt);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
