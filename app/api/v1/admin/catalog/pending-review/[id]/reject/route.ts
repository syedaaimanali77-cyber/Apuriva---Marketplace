import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { rejectSuggestion } from '@/lib/catalog/suggestions';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3 AI suggestion review, `POST /api/v1/admin/catalog/pending-review/{id}/reject` —
 * records reviewer/time; publishes nothing; `409 SUGGESTION_ALREADY_REVIEWED` if not
 * `pending_review`. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const suggestion = await rejectSuggestion(session.userId, idFromUrl(request));
  return apiSuccess(suggestion, correlationId);
});
