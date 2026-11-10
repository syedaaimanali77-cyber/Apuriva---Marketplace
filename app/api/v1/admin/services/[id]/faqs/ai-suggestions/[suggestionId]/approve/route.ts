import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { approveAiSuggestedFaq } from '@/lib/service-page/faqs';

function suggestionIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 011 §3/AC-5, `POST /api/v1/admin/services/{id}/faqs/ai-suggestions/{suggestionId}/approve`
 * — publishes an AI-drafted FAQ; only an authorized admin's explicit decision does this, never
 * the AI itself. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const faq = await approveAiSuggestedFaq(session.userId, suggestionIdFromUrl(request));
  return apiSuccess(faq, correlationId);
});
