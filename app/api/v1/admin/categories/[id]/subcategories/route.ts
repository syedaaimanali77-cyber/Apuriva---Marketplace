import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createSubcategory, listSubcategoriesAdmin } from '@/lib/catalog/subcategories';
import type { CreateSubcategoryRequest } from '@/lib/types/catalog';

/** .../admin/categories/{categoryId}/subcategories — categoryId is the second-to-last segment. */
function categoryIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3, `GET /api/v1/admin/categories/{categoryId}/subcategories` — all statuses under
 * that category. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const subcategories = await listSubcategoriesAdmin(session.userId, categoryIdFromUrl(request));
  return apiSuccess(subcategories, correlationId);
});

/** Spec 010 §3/AC-2, `POST /api/v1/admin/categories/{categoryId}/subcategories` — parent category
 * must be active. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateSubcategoryRequest>;
  const subcategory = await createSubcategory(session.userId, categoryIdFromUrl(request), body as CreateSubcategoryRequest);
  return apiSuccess(subcategory, correlationId, { status: 201 });
});
