import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { setProviderCancellationOption } from '@/lib/cancellation';

function serviceIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 023 §3, `PUT /api/v1/providers/me/services/{id}/cancellation-option` — AC-4.
 *
 * The ONE place a provider can influence cancellation policy, and it accepts a `optionKey` the
 * effective policy version already published — never a percentage, an amount or a tier. There is no
 * column anywhere that could store a provider-authored fee, so "a provider invents an arbitrary
 * fee" is impossible by construction rather than by validation alone.
 *
 * `null` clears the selection and falls back to the version's own tiers. An unknown key is
 * `422 POLICY_OPTION_NOT_ALLOWED`, naming what IS allowed so the failure is actionable.
 *
 * The provider profile is resolved from the session by `requireOwnProviderProfile` — no profile id
 * is ever accepted from the client, so this route has no IDOR surface.
 */
export const PUT = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  const profile = await requireOwnProviderProfile(session.userId);

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const raw = (await request.json().catch(() => null)) as { optionKey?: unknown } | null;
  const optionKey = raw?.optionKey ?? null;
  if (optionKey !== null && typeof optionKey !== 'string') {
    throw validationError([{ field: 'optionKey', message: 'must be a string or null' }]);
  }

  const result = await setProviderCancellationOption(profile.id, serviceIdFromUrl(request), optionKey);
  return apiSuccess(result, correlationId);
});
