import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createService } from '@/lib/catalog/services';
import type { CreateServiceRequest } from '@/lib/types/catalog';

/** Spec 010 §3/AC-2, `POST /api/v1/admin/services` — `422 INVALID_TAXONOMY_PATH` if
 * category/subcategory is invalid or inactive. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateServiceRequest>;
  const service = await createService(session.userId, body as CreateServiceRequest);
  return apiSuccess(service, correlationId, { status: 201 });
});
