import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listPendingSuggestions } from '@/lib/catalog/suggestions';

/** Spec 010 §3, `GET /api/v1/admin/catalog/pending-review` — suggestions currently
 * `pending_review`, Content/Marketplace admin only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const page = parsePageParams(new URL(request.url).searchParams);

  const { items, total } = await listPendingSuggestions(session.userId, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
