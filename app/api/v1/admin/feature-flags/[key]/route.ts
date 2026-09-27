import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { toggleFeatureFlag } from '@/lib/feature-flags';

function keyFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/**
 * Spec 041 §3.6 F2, `PATCH /api/v1/admin/feature-flags/{key}` — change one flag for the RUNNING
 * environment only (AC-1, AC-6). Body `{ environment, enabled, expectedVersion, reason }`. Business
 * flags need `feature_flags/toggle`, developer flags `toggle_technical` (Super Admin). Every applied
 * change writes one spec 039 audit row (AC-3). No Idempotency-Key: `expectedVersion` plus the no-op
 * rule make a retry safe, as spec 017's `PATCH …/matching-weights` does.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
  const body = await request.json().catch(() => ({}));
  return apiSuccess(await toggleFeatureFlag(session.userId, keyFromUrl(request), body), correlationId);
});
