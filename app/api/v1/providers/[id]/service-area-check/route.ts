import { eq } from 'drizzle-orm';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getDb } from '@/lib/db';
import { providerProfiles } from '@/lib/db/schema';
import { isValidLatitude, isValidLongitude } from '@/lib/location/geo';
import { isProviderEligibleForLocation } from '@/lib/availability/service-areas';

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
 * Spec 016 has now shipped the `provider_service_areas` configuration this route was waiting on,
 * so the previously inert `{ inServiceArea: true }` answer is replaced by a real evaluation
 * through `isProviderEligibleForLocation()` (spec 016 §3 S2–S4, AC-3/AC-4). Path, auth, response
 * shape and rate-limit domain are unchanged — spec 016 §3 "Breaking-change check".
 *
 * The check is deliberately against the provider's GLOBAL area: this route carries no
 * `serviceId`, and spec 016 S2 falls back to the global row whenever no service-specific one
 * applies. A provider with no configured area at all stays unrestricted, exactly as before.
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

  // Spec 016 S4: `city` is unknown here (the caller supplies only coordinates), so a `cities`
  // area can only match once the caller resolves a city — a radius area is evaluated exactly.
  const inServiceArea = await isProviderEligibleForLocation(providerId, null, {
    point: { latitude, longitude },
  });

  return apiSuccess({ inServiceArea }, correlationId);
});
