import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { listServiceFields } from '@/lib/service-page/fields';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3, `GET /api/v1/services/{id}/fields` — consumed identically by the manual request
 * form and the AI conversational flow (spec 034). No auth required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const fields = await listServiceFields(idFromUrl(request));
  return apiSuccess(fields, correlationId);
});
