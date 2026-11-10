import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { parsePageParams } from '@/lib/api/pagination';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { createRequest } from '@/lib/requests/create';
import { listRequests } from '@/lib/requests/read';
import type { CreateRequestRequest, RequestListFilter } from '@/lib/types/requests';

/**
 * Spec 015 §3, `POST /api/v1/requests` — AC-1/AC-6.
 *
 * Deliberately a thin transport wrapper: session, CSRF, mode, rate limit and the
 * `Idempotency-Key` header are transport concerns, and **every** domain rule (field validation,
 * budget, ownership, the draft->submitted transition) lives in `createRequest`. That is what makes
 * AC-6 true — a future MCP tool (spec 036) calling `createRequest` directly is validated
 * identically, because there is nothing extra here for it to miss.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('requests', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = (await request.json().catch(() => ({}))) as Partial<CreateRequestRequest>;

  const { request: dto, replayed } = await createRequest(session.userId, idempotencyKey, body);
  // §3 Idempotency: a replay returns the original request with `200`, never a second `201`.
  return apiSuccess(dto, correlationId, { status: replayed ? 200 : 201 });
});

/** Spec 015 §3, `GET /api/v1/requests` — the caller's own requests only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'customer');

  const limit = checkRateLimit('requests', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const filter: RequestListFilter = url.searchParams.get('filter') === 'history' ? 'history' : 'active';
  const page = parsePageParams(url.searchParams);

  const result = await listRequests(session.userId, filter, page);
  return apiPaged(result.data, result.page, correlationId);
});
