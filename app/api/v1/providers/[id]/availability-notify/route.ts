import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requestAvailabilityNotification } from '@/lib/availability/notify';
import { segmentFromUrl } from '../../path-params';

/**
 * Spec 016 §3, `POST /api/v1/providers/{id}/availability-notify` — AC-6. Customer mode: this is
 * the one availability endpoint a customer (rather than the owning provider) writes through.
 *
 * Idempotent: a repeat call while an opt-in is still `pending` answers `200` with the same row
 * rather than `201` and a duplicate. A provider already resolved `available` is
 * `422 AVAILABILITY_NOTIFY_NOT_APPLICABLE` — there is nothing to be notified about.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  // .../providers/{id}/availability-notify
  const providerProfileId = segmentFromUrl(request, 1);
  const { dto, created } = await requestAvailabilityNotification(session.userId, providerProfileId);
  return apiSuccess(dto, correlationId, { status: created ? 201 : 200 });
});
