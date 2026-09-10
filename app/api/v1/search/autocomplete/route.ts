import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getAutocompleteSuggestions } from '@/lib/search/autocomplete';

/** Spec 013 §3, `GET /api/v1/search/autocomplete` — session or guest (AC-2). A signed-in caller's
 * own recent searches are included; a guest gets popular/category/service/location suggestions
 * only — no private data is ever exposed to a caller it doesn't belong to. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('search', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const q = new URL(request.url).searchParams.get('q') ?? '';
  const suggestions = await getAutocompleteSuggestions(q, session?.userId ?? null);
  return apiSuccess(suggestions, correlationId);
});
