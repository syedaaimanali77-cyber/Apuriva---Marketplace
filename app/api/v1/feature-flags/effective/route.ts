import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { resolveClientFlags } from '@/lib/feature-flags';
import type { EffectiveFeatureFlagsDto } from '@/lib/types/feature-flags';

/**
 * Spec 041 §3.6 F3, `GET /api/v1/feature-flags/effective` — the CLIENT-READABLE flags for the running
 * environment, the same for guests and signed-in users. A developer flag is never returned (a CHECK
 * makes it impossible, AC-2). `no-store`, so no shared cache delays a change. Server code never calls
 * this — it reads flags in-process through `isFeatureEnabled()`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('default', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
  const body: EffectiveFeatureFlagsDto = { flags: await resolveClientFlags() };
  const response = apiSuccess(body, correlationId);
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
