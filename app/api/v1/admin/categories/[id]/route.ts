import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { editCategory, getCategoryAdmin } from '@/lib/catalog/categories';
import type { EditCategoryRequest } from '@/lib/types/catalog';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/** Spec 010 §3, `GET /api/v1/admin/categories/{id}` — any status, Content/Marketplace admin
 * only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const category = await getCategoryAdmin(session.userId, idFromUrl(request));
  return apiSuccess(category, correlationId);
});

/** Spec 010 §3/AC-2, `PATCH /api/v1/admin/categories/{id}` — optimistic concurrency via
 * `expectedVersion` (see Versioning, §3). */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as EditCategoryRequest;
  const category = await editCategory(session.userId, idFromUrl(request), body);
  return apiSuccess(category, correlationId);
});
