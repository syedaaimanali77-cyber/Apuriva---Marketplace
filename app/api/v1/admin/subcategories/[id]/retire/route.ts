import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { retireSubcategory } from '@/lib/catalog/subcategories';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3/§4 Retirement and reassignment, `POST /api/v1/admin/subcategories/{id}/retire` —
 * `422 SUBCATEGORY_HAS_ACTIVE_SERVICES` unless every attached active service is reassigned
 * first. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const subcategory = await retireSubcategory(session.userId, idFromUrl(request));
  return apiSuccess(subcategory, correlationId);
});
