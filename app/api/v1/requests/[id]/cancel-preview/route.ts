import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { previewCancelRequest } from '@/lib/requests/cancel';
import { requestIdFromUrl } from '../../request-id';

/**
 * Spec 015 §3, `GET /api/v1/requests/{id}/cancel-preview` — AC-4. The read-only dry run master
 * spec §38 requires so the consequence is shown *before* the destructive action. Never mutates.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('requests', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const preview = await previewCancelRequest(session.userId, requestIdFromUrl(request, 1));
  return apiSuccess(preview, correlationId);
});
