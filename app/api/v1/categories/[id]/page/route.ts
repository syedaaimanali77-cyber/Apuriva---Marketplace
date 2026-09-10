import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getCategoryPage } from '@/lib/service-page/page';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3/AC-1, `GET /api/v1/categories/{id}/page` — aggregated page data. No auth
 * required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const page = await getCategoryPage(idFromUrl(request));
  return apiSuccess(page, correlationId);
});
