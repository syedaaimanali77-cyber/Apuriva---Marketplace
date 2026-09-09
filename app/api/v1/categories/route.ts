import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { listCategoriesPublic } from '@/lib/catalog/categories';

/** Spec 010 §3/AC-5, `GET /api/v1/categories` — published only, no auth required. */
export const GET = withApiRoute(async (_request, correlationId) => {
  const categories = await listCategoriesPublic();
  return apiSuccess(categories, correlationId);
});
