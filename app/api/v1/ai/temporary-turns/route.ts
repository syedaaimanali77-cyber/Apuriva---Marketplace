import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { sendTemporaryTurn } from '@/lib/ai-assistant';

/**
 * Spec 034 §3.11, `POST /api/v1/ai/temporary-turns` (AC-14, AC-18) — one temporary turn.
 *
 * CONVERSATION-ONLY AND SERVER-STATELESS. It writes no conversation, message, memory or action row,
 * never invokes the executor at any risk tier, discards any memory proposal and logs no content. It
 * CREATES NOTHING, so it takes no `Idempotency-Key` — spec 032's `POST /support/assistant` precedent;
 * storing a replay record would mean storing the reply. No rate-limit check here: `completeAi()`
 * limits the call on spec 033's `ai` domain.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = await request.json().catch(() => ({}));
  const reply = await sendTemporaryTurn(session.userId, body);
  return apiSuccess(reply, correlationId);
});
