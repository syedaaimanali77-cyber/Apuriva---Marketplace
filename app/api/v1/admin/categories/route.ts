import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createCategory, listCategoriesAdmin } from '@/lib/catalog/categories';
import type { CreateCategoryRequest } from '@/lib/types/catalog';

/** Spec 010 §3, `GET /api/v1/admin/categories` — all statuses, Content/Marketplace admin only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const categories = await listCategoriesAdmin(session.userId);
  return apiSuccess(categories, correlationId);
});

/** Spec 010 §3/AC-2, `POST /api/v1/admin/categories` — validates required fields + slug
 * uniqueness. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateCategoryRequest>;
  const category = await createCategory(session.userId, body as CreateCategoryRequest);
  return apiSuccess(category, correlationId, { status: 201 });
});
