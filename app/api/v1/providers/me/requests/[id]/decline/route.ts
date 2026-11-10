import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { declineRequest } from '@/lib/matching/provider-requests';
import { providerRequestIdFromUrl } from '../../request-id';

/**
 * Spec 017 §3 AC-5, `POST /api/v1/providers/me/requests/{id}/decline` — always available while
 * the request is actionable and the provider has not already responded (`declineRequest` shares
 * `respondToRequest` with accept, so it enforces the same distributed-to/actionable-status/
 * idempotency rules).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const dto = await declineRequest(profile.id, providerRequestIdFromUrl(request, 1));
  return apiSuccess(dto, correlationId);
});
