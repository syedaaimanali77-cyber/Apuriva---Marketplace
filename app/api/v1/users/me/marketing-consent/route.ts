import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { setMarketingConsent } from '@/lib/notifications';

/**
 * Spec 026 §3, `POST /api/v1/users/me/marketing-consent` (AC-3). Body `{ consent: boolean }`; idempotent.
 * Every change appends a compliance record to `security_events`; withdrawal takes effect immediately.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  return apiSuccess(await setMarketingConsent(session.userId, body), correlationId);
});
