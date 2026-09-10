import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createServiceField } from '@/lib/service-page/fields';
import type { CreateServiceFieldRequest } from '@/lib/types/service-page';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3, `POST /api/v1/admin/services/{id}/fields` — Content/Marketplace admin;
 * `400 VALIDATION_ERROR` when the field definition itself is malformed. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateServiceFieldRequest>;
  const field = await createServiceField(session.userId, idFromUrl(request), body as CreateServiceFieldRequest);
  return apiSuccess(field, correlationId, { status: 201 });
});
