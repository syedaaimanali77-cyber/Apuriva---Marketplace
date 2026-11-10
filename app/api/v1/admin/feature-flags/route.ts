import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { listFeatureFlags } from '@/lib/feature-flags';

/**
 * Spec 041 §3.6 F1, `GET /api/v1/admin/feature-flags` — the running environment's flags the caller
 * may see (`feature_flags/read`; developer flags only with `read_technical`, otherwise ABSENT — AC-2).
 * Unpaged: a closed registry, the same case as spec 036's `GET /admin/mcp/tools`. Read-only, so no CSRF.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
  return apiSuccess(await listFeatureFlags(session.userId), correlationId);
});
