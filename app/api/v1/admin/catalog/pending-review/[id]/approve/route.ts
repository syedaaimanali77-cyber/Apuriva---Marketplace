import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { approveSuggestion } from '@/lib/catalog/suggestions';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/** Spec 010 §3 AI suggestion review, `POST /api/v1/admin/catalog/pending-review/{id}/approve` —
 * creates the resulting entity `pending_review` (never `published` directly — AI never publishes,
 * see Lifecycle §4); `409 SUGGESTION_ALREADY_REVIEWED` if not `pending_review`. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const suggestion = await approveSuggestion(session.userId, idFromUrl(request));
  return apiSuccess(suggestion, correlationId);
});
