import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { updateMatchingWeights } from '@/lib/matching/admin';
import type { UpdateMatchingWeightsRequest } from '@/lib/types/matching';

function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // .../admin/services/{id}/matching-weights — the id sits two segments before the end.
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 017 §3 AC-2, `PATCH /api/v1/admin/services/{id}/matching-weights` — the only mutation
 * surface for a service's ranking-weight/pool-size override. `updateMatchingWeights`
 * (lib/matching/admin.ts) authorizes via `matching.config`/`configure` (risk tier medium, seeded
 * for `operations_admin`/`super_admin` by this spec's migration), validates weights sum to
 * exactly 100 and pool size falls within 1-50 (`422 INVALID_MATCHING_WEIGHTS` otherwise), and
 * enforces optimistic concurrency via `expectedVersion` (`409 CONFLICT` on a stale version).
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as UpdateMatchingWeightsRequest;
  const dto = await updateMatchingWeights(session.userId, idFromUrl(request), body);
  return apiSuccess(dto, correlationId);
});
