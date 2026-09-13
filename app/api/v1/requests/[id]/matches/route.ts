import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getMatchExplainability } from '@/lib/matching/admin';
import { requestIdFromUrl } from '../../request-id';

/**
 * Spec 017 §3 AC-6, `GET /api/v1/requests/{id}/matches` — admin-only ranking explainability:
 * which providers were excluded and why, plus the ranking breakdown for the eligible pool.
 *
 * Deliberately under `/requests/{id}/matches`, not `/providers/**`: this is admin-only data about
 * a request, never a provider- or customer-facing surface. `getMatchExplainability` resolves
 * authorization itself via `lib/admin-rbac/permissions.ts` (`matching.config`/`read`, granted to
 * `operations_admin`/`super_admin` — spec 017's migration seeds it), so a non-admin or an admin
 * lacking that permission gets `403 FORBIDDEN` before any request/provider data is read.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dto = await getMatchExplainability(session.userId, requestIdFromUrl(request, 1));
  return apiSuccess(dto, correlationId);
});
