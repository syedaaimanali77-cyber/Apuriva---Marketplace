import { eq } from 'drizzle-orm';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getDb } from '@/lib/db';
import { providerProfiles, providerServiceAreas } from '@/lib/db/schema';
import { isValidLatitude, isValidLongitude } from '@/lib/location/geo';

/** Extracted from the URL directly — `withApiRoute` only forwards `(request, correlationId)`. */
function providerIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // .../providers/{id}/service-area-check
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 012 §3, `GET /api/v1/providers/{id}/service-area-check?lat=&lng=` — session or guest.
 * Never returns the provider's own exact coordinates (§3).
 *
 * `provider_service_areas` (spec 003 baseline) has no radius/cities columns yet — those are
 * spec 016's (provider-availability-service-areas) to add; spec 012 §7 "Out of scope" provides
 * only the geo/distance primitive (`lib/location/service-area.ts`) that spec 016's configured
 * area is checked against. Until spec 016 ships real configuration, a provider has no declared
 * area to be excluded by, so every candidate point is treated as in-area (not excluded) — the
 * same "no configured restriction = unrestricted" default a real service-area feature would use
 * for a provider who hasn't set one up yet.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('location', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const providerId = providerIdFromUrl(request);
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const latitude = lat === null ? NaN : Number(lat);
  const longitude = lng === null ? NaN : Number(lng);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw validationError([
      { field: 'lat', message: 'must be a valid latitude query parameter' },
      { field: 'lng', message: 'must be a valid longitude query parameter' },
    ]);
  }

  const [provider] = await getDb().select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.id, providerId));
  if (!provider) throw new ApiRouteError('NOT_FOUND', 'The requested provider does not exist.');

  // No configured service area today (see file header) — nothing to exclude the candidate from.
  await getDb().select({ id: providerServiceAreas.id }).from(providerServiceAreas).where(eq(providerServiceAreas.providerProfileId, providerId));

  return apiSuccess({ inServiceArea: true }, correlationId);
});
