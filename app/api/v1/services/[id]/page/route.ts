import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getServicePage } from '@/lib/service-page/page';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3, `GET /api/v1/services/{id}/page` — includes fields, FAQs, packages, pricing. No
 * auth required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const page = await getServicePage(idFromUrl(request));
  return apiSuccess(page, correlationId);
});
