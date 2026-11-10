import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { getRequestForOwner } from '@/lib/requests/read';
import { requestIdFromUrl } from '../request-id';

/**
 * Spec 015 §3, `GET /api/v1/requests/{id}` — owner only. A request that isn't the caller's is
 * indistinguishable from one that doesn't exist (`404 REQUEST_NOT_FOUND`), and AC-5's
 * customer-facing step is derived server-side; no matching internals are ever returned.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('requests', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dto = await getRequestForOwner(session.userId, requestIdFromUrl(request));
  return apiSuccess(dto, correlationId);
});
