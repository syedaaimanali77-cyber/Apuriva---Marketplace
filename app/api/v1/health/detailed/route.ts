import { withApiRoute } from '@/lib/api/handler';
import { ApiRouteError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { canReadDetailedHealth } from '@/lib/ops/access';
import { buildDetailedHealth } from '@/lib/ops/health';

export const dynamic = 'force-dynamic';

/**
 * Spec 046 §3.7 (AC-8), `GET /api/v1/health/detailed` — readiness and diagnostics, for the
 * ops-health-check monitor (MONITORING_TOKEN) or an MFA-complete Super Admin. `200` when healthy or
 * degraded, `503` with the same body when the database is down. Never cached. Liveness remains
 * spec 001's unauthenticated `GET /api/v1/health`, which this route does not change.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const limit = checkRateLimit('default', `health-detailed:${hashRequestIp(request) ?? 'unknown'}`);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  if (!(await canReadDetailedHealth(request))) {
    throw new ApiRouteError('UNAUTHENTICATED', 'Monitoring credentials are required.');
  }

  const health = await buildDetailedHealth();
  const res = apiSuccess(health, correlationId, { status: health.status === 'down' ? 503 : 200 });
  res.headers.set('Cache-Control', 'no-store');
  return res;
});
