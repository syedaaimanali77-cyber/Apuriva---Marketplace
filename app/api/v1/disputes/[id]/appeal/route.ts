import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { fileAppeal, parseAppealRequest } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../dispute-id';

/**
 * Spec 031 §3 "Appeal rules" (AC-4, DECIDED-4), `POST /api/v1/disputes/{id}/appeal`.
 *
 * EITHER PARTICIPANT may appeal, not only the opener — a resolution can go against the party who
 * did not open the dispute, and giving only the opener an appeal would be arbitrary.
 *
 * EXACTLY ONE per dispute, enforced by `dispute_appeals_dispute_uq` at the database, so whoever
 * files second gets `409 APPEAL_ALREADY_FILED` regardless of concurrency.
 *
 * WITHIN `DISPUTE_APPEAL_WINDOW_DAYS` of `resolved_at`, else `422 APPEAL_WINDOW_CLOSED`.
 *
 * NOTHING IS RELEASED. The dispute moves `resolved -> appealed`, which is still not `closed`, so
 * `lib/disputes/gate.ts` keeps answering `open: true` and the payment stays `disputed`. That is
 * what makes AC-4's "the money stays held" true without a second mechanism.
 *
 * NOBODY IS NOTIFIED (§8). The counterparty sees the appeal in the dispute view; a push saying
 * "you are being appealed" would add pressure without adding information.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseAppealRequest(body);

  const { appeal, replayed } = await fileAppeal(disputeId, session.userId, input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(appeal, correlationId, { status: replayed ? 200 : 201 });
});
