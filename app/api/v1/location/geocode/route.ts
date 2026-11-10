import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { geocodeAddress } from '@/lib/location/addresses';
import { toGeocodeResultDto } from '@/lib/location/privacy';
import type { GeocodeRequest } from '@/lib/types/location';

/**
 * Spec 012 §3, `POST /api/v1/location/geocode` — session or guest. The caller resolving their
 * own address text is always authorized to see the exact point it resolves to (that's the whole
 * purpose of the call); stripping only applies when *someone else's* location is being viewed
 * (AC-3/AC-4, `lib/location/privacy.ts`).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);

  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('location', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as Partial<GeocodeRequest>;
  if (typeof body.address !== 'string' || body.address.trim().length === 0) {
    throw validationError([{ field: 'address', message: 'is required' }]);
  }

  const result = await geocodeAddress(body.address);
  const dto = toGeocodeResultDto(result, result.structured, true);
  return apiSuccess(dto, correlationId);
});
