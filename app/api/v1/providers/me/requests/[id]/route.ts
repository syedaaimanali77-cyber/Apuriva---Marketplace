import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { getIncomingRequest } from '@/lib/matching/provider-requests';
import { providerRequestIdFromUrl } from '../request-id';

/**
 * Spec 017 §3 AC-5, `GET /api/v1/providers/me/requests/{id}` — a single distributed request, with
 * its available action for this provider. `403 NOT_DISTRIBUTED_TO_PROVIDER` for a request that
 * exists but was never distributed to this provider, and for a non-existent id too — the two
 * cases are indistinguishable so a caller cannot probe request ids by comparing responses.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const dto = await getIncomingRequest(profile.id, providerRequestIdFromUrl(request));
  return apiSuccess(dto, correlationId);
});
