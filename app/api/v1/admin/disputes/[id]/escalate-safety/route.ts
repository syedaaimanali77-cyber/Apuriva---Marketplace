import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { escalateToSafety, parseSafetyEscalationRequest } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3 "Safety boundary" (DECIDED-9),
 * `POST /api/v1/admin/disputes/{id}/escalate-safety`.
 *
 * ONE-WAY ONLY. Spec 030 §1 already states the direction: "a safety concern arising from a dispute
 * escalates here, not the reverse." This route is that seam and nothing more.
 *
 * TWO PERMISSIONS, NOT ONE: `disputes/resolve` AND spec 030's `safety_reports/read`. Crossing into
 * the Trust & Safety queue should require belonging to it — an admin who can decide disputes must
 * not be able to inject records into someone else's queue.
 *
 * IT CALLS SPEC 030's OWN CREATION PATH, never `INSERT INTO safety_reports`. So spec 030 keeps
 * ownership of the self-report check, the target-exists check, its default priority (it performs NO
 * automated classification) and its own audit trail. This spec sets no priority, applies no
 * restriction, writes no `users.lifecycle_status` and creates no moderation action — those are spec
 * 038's, and spec 030 does not own them either.
 *
 * `targetUserId` must be a participant of THIS booking: an escalation naming an unrelated person
 * would be a way to file a safety report while attributing it to a dispute they have nothing to do
 * with.
 *
 * ESCALATING DOES NOT PAUSE THE DISPUTE. The two records proceed independently — a safety concern
 * and a money disagreement are answered by different people on different timelines.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseSafetyEscalationRequest(body);

  const result = await escalateToSafety(
    disputeIdFromUrl(request, 1),
    session.userId,
    input,
    { key, fingerprint: idempotencyFingerprint(input) },
    correlationId,
  );

  return apiSuccess(result, correlationId, { status: 201 });
});
