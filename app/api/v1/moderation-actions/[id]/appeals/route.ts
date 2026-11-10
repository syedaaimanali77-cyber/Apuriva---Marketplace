import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { fileModerationAppeal, parseAppealRequest } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../moderation-route';

/**
 * Spec 038 §3.13 U2, `POST /api/v1/moderation-actions/{id}/appeals` — the TARGET files the one
 * appeal an active, appealable action may carry (anyone else: `404`). ON THE §3.5 ALLOW-LIST, so it
 * stays reachable while suspended or banned. `Idempotency-Key` required; a replay is `200`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowModeratedAccount: true });
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  const idempotencyKey = requireIdempotencyKey(request);
  const input = parseAppealRequest(await request.json().catch(() => ({})));
  const actionId = pathId(request, 1);
  const { appeal, replayed } = await fileModerationAppeal({
    userId: session.userId,
    actionId,
    statement: input.statement,
    idempotencyKey,
    fingerprint: idempotencyFingerprint({ actionId, ...input }),
    correlationId,
  });
  return apiSuccess(appeal, correlationId, { status: replayed ? 200 : 201 });
});
