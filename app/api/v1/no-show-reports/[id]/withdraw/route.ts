import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { withdrawNoShow } from '@/lib/no-show';

function reportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 023 §3, `POST /api/v1/no-show-reports/{id}/withdraw`.
 *
 * A mistaken report must be retractable before it consumes the other party's time or a reviewer's,
 * so the reporter may withdraw while the report is still `awaiting_response` — and only then. Once
 * it is `under_review` a human is involved and the record stands: `409`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const report = await withdrawNoShow(session.userId, reportIdFromUrl(request));
  return apiSuccess(report, correlationId);
});
