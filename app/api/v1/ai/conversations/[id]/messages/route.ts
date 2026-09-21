import { withApiRoute } from '@/lib/api/handler';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { listTranscript, sendTurn } from '@/lib/ai-assistant';
import { aiIdFromUrl, enforceDefaultRateLimit } from '../../../ai-route-support';

/**
 * Spec 034 §3.2, `GET /api/v1/ai/conversations/{id}/messages` — the transcript in
 * `created_at ASC, id ASC` order. Never gated by the assistant flag.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceDefaultRateLimit(session.userId);

  const result = await listTranscript(session.userId, aiIdFromUrl(request, 1), parsePageParams(new URL(request.url).searchParams));
  return apiPaged(result.data, result.page, correlationId);
});

/**
 * Spec 034 §3.3, `POST /api/v1/ai/conversations/{id}/messages` — one turn (AC-1, AC-2, AC-13).
 * `Idempotency-Key` required: `201` on a new turn, `200` with the original reply on replay, which
 * spends no AI quota. No rate-limit check here: `completeAi()` limits the call on spec 033's `ai`
 * domain. A degradable AI failure returns spec 033's code and stores neither half of the turn.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const { message, replayed } = await sendTurn(
    { userId: session.userId, sessionId: session.id, conversationId: aiIdFromUrl(request, 1) },
    idempotencyKey,
    body,
  );
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});
