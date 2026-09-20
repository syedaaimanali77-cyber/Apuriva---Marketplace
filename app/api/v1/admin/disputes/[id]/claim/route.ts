import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { claimDispute } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/admin/disputes/{id}/claim` — `open -> under_review`.
 *
 * A reason is NOT required: claiming changes no outcome, it only records who is working the case so
 * two admins do not duplicate the effort. Demanding prose before an admin may even start reading
 * would be friction with no audit value. The claim is still audited (`disputes.claimed`).
 *
 * Claiming is OPTIONAL — `open -> resolved` is a legal transition too. A single admin working a
 * simple dispute should not have to perform a two-step ceremony to record one decision.
 *
 * Concurrency: the conditional `UPDATE … WHERE status = 'open'` means a second claimer matches zero
 * rows and gets `409 CONFLICT` with the current status, so they can refetch and decide again. Same
 * "exactly one winner" shape spec 009 uses for approvals, with no new mechanism.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dispute = await claimDispute(disputeIdFromUrl(request, 1), session.userId, correlationId);
  return apiSuccess(dispute, correlationId);
});
