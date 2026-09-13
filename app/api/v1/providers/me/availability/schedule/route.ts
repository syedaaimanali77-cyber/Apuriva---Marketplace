import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { getWeeklySchedule, putWeeklySchedule } from '@/lib/availability/schedule';
import type { WeeklyScheduleRequest } from '@/lib/types/availability';

/**
 * Spec 016 §3, `GET /api/v1/providers/me/availability/schedule` — owner-only (R1/R2).
 * The provider id is never taken from the client: it is resolved from the session user.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  return apiSuccess(await getWeeklySchedule(profile.id, profile.version, profile.timezone), correlationId);
});

/**
 * Spec 016 §3, `PUT /api/v1/providers/me/availability/schedule` — AC-1's weekly half.
 *
 * Replaces the WHOLE weekly set in one transaction: R2's "entries on a day may not overlap or
 * touch" is a property of the complete set, so a partial update could not be validated. Guarded
 * by `expectedVersion` (spec 003 AC-6) and by the strand check (§8 risk #6).
 */
export const PUT = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const body = (await request.json().catch(() => ({}))) as Partial<WeeklyScheduleRequest>;
  return apiSuccess(await putWeeklySchedule(profile.id, body), correlationId);
});
