import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { reverseGeocodePoint } from '@/lib/location/addresses';
import { toGeocodeResultDto } from '@/lib/location/privacy';
import type { ReverseGeocodeRequest } from '@/lib/types/location';

/** Spec 012 §3, `POST /api/v1/location/reverse-geocode` — session or guest. Returns
 * `GeocodeResultDto`, not a saved `AddressDto` — the resolved point has no `id`/`label` yet. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);

  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('location', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as Partial<ReverseGeocodeRequest>;
  if (typeof body.latitude !== 'number' || typeof body.longitude !== 'number') {
    throw validationError([
      { field: 'latitude', message: 'is required' },
      { field: 'longitude', message: 'is required' },
    ]);
  }

  const result = await reverseGeocodePoint(body.latitude, body.longitude);
  const dto = toGeocodeResultDto(result, result.structured, true);
  return apiSuccess(dto, correlationId);
});
