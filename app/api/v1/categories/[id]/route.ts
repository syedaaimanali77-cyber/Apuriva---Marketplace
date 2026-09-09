import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getCategoryPublic } from '@/lib/catalog/categories';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/** Spec 010 §3/AC-5, `GET /api/v1/categories/{id}` — published only, with only published child
 * subcategories. No auth required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const category = await getCategoryPublic(idFromUrl(request));
  return apiSuccess(category, correlationId);
});
