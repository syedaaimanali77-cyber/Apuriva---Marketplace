import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listPendingReviews } from '@/lib/admin-rbac/queries';

/** Spec 009 §3.2/AC-3, `GET /api/v1/admin/actions/pending-review` — every `AdminAction` awaiting
 * mandatory post-action review that the caller is authorized to review. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const page = parsePageParams(new URL(request.url).searchParams);

  const { items, total } = await listPendingReviews(session.userId, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
