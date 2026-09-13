import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { listServiceAreas, putServiceAreas } from '@/lib/availability/service-areas';
import type { ServiceAreasRequest } from '@/lib/types/availability';

/**
 * Spec 016 §3, `GET /api/v1/providers/me/service-areas` — owner-only (S1).
 *
 * Returns the centre as an address id plus an approximate area label, never raw coordinates:
 * spec 012's privacy rule, preserved.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  return apiSuccess(await listServiceAreas(profile.id), correlationId);
});

/**
 * Spec 016 §3, `PUT /api/v1/providers/me/service-areas` — AC-3/AC-4 configuration (S1–S5).
 *
 * Replaces the whole set in one transaction, so a single rejected entry leaves the previous
 * configuration completely untouched. Covers both the provider-wide default (`serviceId` omitted)
 * and per-service areas, in all three modes: radius, cities, remote.
 */
export const PUT = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const body = (await request.json().catch(() => ({}))) as Partial<ServiceAreasRequest>;
  return apiSuccess(await putServiceAreas(profile.id, session.userId, body), correlationId);
});
