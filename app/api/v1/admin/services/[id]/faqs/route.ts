import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createOfficialFaq } from '@/lib/service-page/faqs';
import type { CreateServiceFaqRequest } from '@/lib/types/service-page';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3, `POST /api/v1/admin/services/{id}/faqs` — official FAQ, Content/Marketplace
 * admin, published immediately. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateServiceFaqRequest>;
  const faq = await createOfficialFaq(session.userId, idFromUrl(request), body);
  return apiSuccess(faq, correlationId, { status: 201 });
});
