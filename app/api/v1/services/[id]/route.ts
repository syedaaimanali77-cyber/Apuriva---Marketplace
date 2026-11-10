import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getServicePublic } from '@/lib/catalog/services';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/** Spec 010 §3/AC-5, `GET /api/v1/services/{id}` — `404` unless the service is `published`. No
 * auth required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const service = await getServicePublic(idFromUrl(request));
  return apiSuccess(service, correlationId);
});
