import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { listSuggestions } from '@/lib/ai-assistant';
import { enforceDefaultRateLimit } from '../ai-route-support';

/**
 * Spec 034 §3.10, `GET /api/v1/ai/suggestions` (AC-9, AC-15) — the caller's current proactive
 * suggestions, derived at read time: at most one `upcoming_booking` and one `unfinished_request`.
 * Read-only: it writes nothing and never calls the executor. `[]` when the preference is off, the
 * assistant is off, or the caller has no customer profile.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceDefaultRateLimit(session.userId);
  return apiSuccess(await listSuggestions(session.userId), correlationId);
});
