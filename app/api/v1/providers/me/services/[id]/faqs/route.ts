import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createProviderFaq } from '@/lib/service-page/faqs';
import type { CreateServiceFaqRequest } from '@/lib/types/service-page';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3, `POST /api/v1/providers/me/services/{id}/faqs` — session (provider,
 * ownership-checked): the caller must offer this service (`provider_services`); `403 FORBIDDEN`
 * otherwise. Published immediately, visibly distinguished as provider-sourced (AC-6). */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateServiceFaqRequest>;
  const faq = await createProviderFaq(session.userId, idFromUrl(request), body);
  return apiSuccess(faq, correlationId, { status: 201 });
});
