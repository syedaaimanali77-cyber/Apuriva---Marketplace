import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams } from '@/lib/api/pagination';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { listCustomerThreadMessages, sendCustomerMessage } from '@/lib/negotiation/messages';
import { requestIdFromUrl } from '../../../../request-id';

/** `/requests/{id}/message-threads/{providerProfileId}/messages` — `{id}` sits 3 segments from the end. */
function threadParams(request: Request): { requestId: string; providerProfileId: string } {
  return { requestId: requestIdFromUrl(request, 3), providerProfileId: requestIdFromUrl(request, 1) };
}

/** Spec 019 §3 — the customer's view of one pre-selection thread; closed threads stay readable (AC-8). */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const { requestId, providerProfileId } = threadParams(request);
  const page = parsePageParams(new URL(request.url).searchParams);
  const result = await listCustomerThreadMessages(session.userId, requestId, providerProfileId, page);
  return apiPaged(result.data, result.page, correlationId);
});

/**
 * Spec 019 §3 — the customer posts a message (AC-1, AC-7, AC-8). Requires `Idempotency-Key`; a replay
 * returns the original message with `200`. Contact details are removed before storage.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const { requestId, providerProfileId } = threadParams(request);

  const { message, replayed } = await sendCustomerMessage(session.userId, requestId, providerProfileId, idempotencyKey, body);
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});
