import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { retireService } from '@/lib/catalog/services';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3, `POST /api/v1/admin/services/{id}/retire` — soft state change, not delete. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const service = await retireService(session.userId, idFromUrl(request));
  return apiSuccess(service, correlationId);
});
