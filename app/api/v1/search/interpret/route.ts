import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { interpretationLowConfidenceError, validationError } from '@/lib/search/errors';
import { interpretSearchQuery } from '@/lib/search/interpret';
import { isNlInterpretationEnabled } from '@/lib/search/feature-flags';

/**
 * Spec 013 §3, `POST /api/v1/search/interpret` — AI-assisted, read-only, low-risk (spec 034's
 * autonomy-tier model). Never returns search results itself (AC-1); the frontend pre-fills the
 * returned intent into real `/api/v1/search` filter parameters. Structurally there is no
 * "isVoice" field anywhere in this request — a voice transcription cannot be given elevated trust
 * by construction (AC-5).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('search', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    throw validationError([{ field: 'text', message: 'is required' }]);
  }

  // §9: falling back to keyword-only search if AI interpretation is disabled/misbehaving.
  if (!isNlInterpretationEnabled()) throw interpretationLowConfidenceError();

  const intent = await interpretSearchQuery(body.text);
  return apiSuccess(intent, correlationId);
});
