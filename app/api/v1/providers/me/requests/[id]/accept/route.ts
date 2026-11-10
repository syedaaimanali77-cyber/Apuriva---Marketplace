import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { acceptRequest } from '@/lib/matching/provider-requests';
import { providerRequestIdFromUrl } from '../../request-id';

/**
 * Spec 017 §3 AC-5, `POST /api/v1/providers/me/requests/{id}/accept` — the claim invariant.
 * `acceptRequest` (lib/matching/provider-requests.ts) does the real work inside one transaction:
 * `SELECT ... FOR UPDATE` on the request row before reading any response state, so two concurrent
 * accepts can never both succeed — the loser gets `409 REQUEST_ALREADY_CLAIMED`. Repeating the
 * SAME action is idempotent (`200` with the existing response); a *different* second action is
 * `422 REQUEST_NOT_ACTIONABLE`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('matching', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const dto = await acceptRequest(profile.id, providerRequestIdFromUrl(request, 1));
  return apiSuccess(dto, correlationId);
});
