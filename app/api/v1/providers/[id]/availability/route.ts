import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getAvailabilitySummary } from '@/lib/availability/summary';
import { segmentFromUrl } from '../../path-params';

/**
 * Spec 016 §3, `GET /api/v1/providers/{id}/availability` — session or guest, AC-5.
 *
 * The ONLY availability endpoint a non-owner may call. It returns `AvailabilitySummaryDto` and
 * nothing more: a state, a fixed reason phrase, and a coarse next-available date. Weekly rows,
 * overrides, slots, occupied intervals, buffers, service areas and the provider's timezone are
 * all owner-only and live under `/providers/me/**` (§3 "Public vs owner-only information").
 *
 * An unavailable provider still resolves here — AC-5's "remains discoverable"; it is the client
 * that disables booking/offer actions, using the `reason` as their explanation.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('availability', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  // .../providers/{id}/availability
  const summary = await getAvailabilitySummary(segmentFromUrl(request, 1));
  return apiSuccess(summary, correlationId);
});
