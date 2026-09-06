import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listPendingApprovals } from '@/lib/admin-rbac/queries';

/** Spec 009 §3, `GET /api/v1/admin/approvals/pending` — every `Pending` `AdminAction` the caller
 * is authorized to decide (lib/admin-rbac/queries.ts). */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const page = parsePageParams(new URL(request.url).searchParams);

  const { items, total } = await listPendingApprovals(session.userId, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
