import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { retireCategory } from '@/lib/catalog/categories';

/** .../admin/categories/{id}/retire — id is the second-to-last segment. */
function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3/§4 Retirement and reassignment, `POST /api/v1/admin/categories/{id}/retire` —
 * `422 CATEGORY_HAS_ACTIVE_SERVICES` unless every attached active service is reassigned first. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const category = await retireCategory(session.userId, idFromUrl(request));
  return apiSuccess(category, correlationId);
});
