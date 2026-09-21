import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { getAiPreferences, updateAiPreferences } from '@/lib/ai-assistant';

/** Spec 034 §3.2, `GET /api/v1/users/me/ai-preferences` — mirrors spec 014's personalization settings. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
  return apiSuccess(await getAiPreferences(session.userId), correlationId);
});

/**
 * Spec 034 §3.10, `PATCH /api/v1/users/me/ai-preferences` — turns EVERY proactive suggestion on or
 * off. Never gated by the assistant flag. System notifications (spec 026) are unaffected.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  return apiSuccess(await updateAiPreferences(session.userId, body), correlationId);
});
