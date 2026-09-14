import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams } from '@/lib/api/pagination';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { listProviderThreadMessages, sendProviderMessage } from '@/lib/negotiation/messages';
import { providerRequestIdFromUrl } from '../../request-id';

/**
 * Spec 019 §3, `GET /api/v1/providers/me/requests/{id}/messages` — the caller's own thread only; `403
 * NOT_DISTRIBUTED_TO_PROVIDER` for a request they were never distributed into (spec 017 pattern).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const page = parsePageParams(new URL(request.url).searchParams);
  const result = await listProviderThreadMessages(profile.id, providerRequestIdFromUrl(request, 1), page);
  return apiPaged(result.data, result.page, correlationId);
});

/**
 * Spec 019 §3 — a distributed provider posts a message, before or after offering (AC-1, AC-7, AC-8).
 * Requires `Idempotency-Key`; contact details are removed before storage.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { message, replayed } = await sendProviderMessage(
    session.userId,
    profile.id,
    providerRequestIdFromUrl(request, 1),
    idempotencyKey,
    body,
  );
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});
