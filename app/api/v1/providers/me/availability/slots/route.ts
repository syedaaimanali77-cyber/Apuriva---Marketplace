import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { getBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { getDb } from '@/lib/db';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { findProviderService, loadOverrides, loadServiceBuffers, loadWeeklyEntries } from '@/lib/availability/repository';
import { generateSlots, widestBufferMinutes } from '@/lib/availability/slots';
import { zonedDateTimeToUtc } from '@/lib/availability/timezone';
import { parseDateRange } from '../date-range';

/**
 * Spec 016 §3, `GET /api/v1/providers/me/availability/slots?serviceId=&from=&to=` — owner-only,
 * FULL detail (R7/R8). This is the endpoint that exposes exact slot boundaries and *why* each is
 * blocked, which is precisely why no customer-facing route may return it.
 *
 * Occupied time comes through the `BusyIntervalLoader` port, never from a booking query: booking
 * schema is approved spec 020's (spec 016 §3 "Interface with spec 020").
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const { from, to } = parseDateRange(request);

  const serviceId = new URL(request.url).searchParams.get('serviceId');
  if (!serviceId) throw validationError([{ field: 'serviceId', message: 'is required.' }]);

  const providerService = await findProviderService(profile.id, serviceId);
  if (!providerService) throw new ApiRouteError('NOT_FOUND', 'You do not offer that service.');

  const [weekly, overrides, buffers] = await Promise.all([
    loadWeeklyEntries(profile.id),
    loadOverrides(profile.id, { from, to }),
    loadServiceBuffers(profile.id),
  ]);

  const margin = (widestBufferMinutes(buffers) + providerService.durationMinutes) * 60_000;
  const busy = await getBusyIntervalLoader()(getDb(), profile.id, {
    from: new Date(zonedDateTimeToUtc(from, 0, profile.timezone).getTime() - margin),
    to: new Date(zonedDateTimeToUtc(to, 1440, profile.timezone).getTime() + margin),
  });

  const slots = generateSlots({
    from,
    to,
    timezone: profile.timezone,
    weekly,
    overrides,
    serviceId,
    durationMinutes: providerService.durationMinutes,
    busy,
    buffers,
  });

  return apiSuccess(slots, correlationId);
});
