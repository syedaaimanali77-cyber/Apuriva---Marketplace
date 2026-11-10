import { withApiRoute } from '@/lib/api/handler';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { confirmAction } from '@/lib/ai-assistant';
import type { AiConfirmResultDto } from '@/lib/types/ai-assistant';
import { aiIdFromUrl, enforceDefaultRateLimit } from '../../../ai-route-support';

/**
 * Spec 034 §3.4/§3.5, `POST /api/v1/ai/conversations/{id}/confirm` (AC-5, AC-6). Body
 * `{ confirmationId }`: the user's explicit confirmation, handed to the executor port. With the inert
 * default port every id is `404`. A stale confirmation surfaces spec 035's own error unchanged.
 * `Idempotency-Key` required: a retry returns the original result instead of executing twice.
 * A temporary conversation has no id, so no confirmation can ever originate from one (AC-18).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const { action, message } = await confirmAction(
    { userId: session.userId, sessionId: session.id, conversationId: aiIdFromUrl(request, 1) },
    idempotencyKey,
    body,
  );
  // Spec 036 amendment: `message` is the assistant's reply generated from the REAL outcome. It is
  // absent on a replay (it is already in the transcript) and when it could not be generated.
  const result: AiConfirmResultDto = message ? { ...action, message } : action;
  return apiSuccess(result, correlationId);
});
