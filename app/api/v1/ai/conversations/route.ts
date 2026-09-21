import { withApiRoute } from '@/lib/api/handler';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { clearHistory, createConversation, listConversations } from '@/lib/ai-assistant';
import { enforceDefaultRateLimit, noContent } from '../ai-route-support';

/**
 * Spec 034 §3.2, `POST /api/v1/ai/conversations` — starts an empty normal conversation. Session,
 * CSRF and `Idempotency-Key`: `201` on creation, `200` with the original on replay. `503` when Ask
 * Apuriva or platform AI is off.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const { conversation, replayed } = await createConversation(session.userId, idempotencyKey, body);
  return apiSuccess(conversation, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * Spec 034 §3.2/§3.3, `GET /api/v1/ai/conversations[?q=]` — the caller's own non-deleted
 * conversations, most recently updated first; `q` searches message bodies case-insensitively.
 * Never gated by the assistant flag (a privacy right, §9).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceDefaultRateLimit(session.userId);

  const { searchParams } = new URL(request.url);
  const result = await listConversations(session.userId, searchParams, parsePageParams(searchParams));
  return apiPaged(result.data, result.page, correlationId);
});

/**
 * Spec 034 §3.2, `DELETE /api/v1/ai/conversations` — CLEAR HISTORY (AC-8). Messages are
 * hard-deleted and conversations tombstoned; activity entries and AI memory are untouched.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  await clearHistory(session.userId);
  return noContent(correlationId);
});
