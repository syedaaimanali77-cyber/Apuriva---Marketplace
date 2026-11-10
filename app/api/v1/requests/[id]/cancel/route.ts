import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { cancelRequest } from '@/lib/requests/cancel';
import type { CancelRequestRequest } from '@/lib/types/requests';
import { requestIdFromUrl } from '../../request-id';

/**
 * Spec 015 §3, `POST /api/v1/requests/{id}/cancel` — AC-4/AC-7. Owner only, cancellable states
 * only, `expectedVersion`-guarded; the DB trigger is the independent second line of defence.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('requests', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as Partial<CancelRequestRequest>;
  const dto = await cancelRequest(session.userId, requestIdFromUrl(request, 1), body.expectedVersion);
  return apiSuccess(dto, correlationId);
});
