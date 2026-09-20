import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getDisputeForAdmin, requireDisputeReadPermission } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../disputes/dispute-id';

/**
 * Spec 031 §3, `GET /api/v1/admin/disputes/{id}` — one dispute in full (AC-3).
 *
 * THIS IS THE ONLY SHAPE THAT CARRIES REAL IDENTITIES: `openedByUserId`, `customerUserId`,
 * `providerUserId`, `claimedByAdminUserId`, `resolvedByAdminUserId`, the advisory `aiSummary`, the
 * `refundAdminActionId` approval chain, the safety cross-reference and the legal-hold flag. None of
 * them exists on the participant DTO.
 *
 * AN ADMIN WHO IS A PARTY TO THE BOOKING IS REFUSED `403 DISPUTE_PARTICIPANT_CONFLICT`, read
 * included. `resolveAdminAccess` decides that with a participation query, never a role check, so it
 * holds however the admin acquired the role. Reading the other side's evidence in your own argument
 * is exactly the self-dealing the rule exists to prevent — and the participant route remains open
 * to them, where they see it as the party they are.
 *
 * Audited as `disputes.detail_read`, separately from the queue: who opened a given dispute is a
 * different fact from who scanned the list.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const dispute = await getDisputeForAdmin(
    disputeIdFromUrl(request),
    session.userId,
    correlationId,
    requireDisputeReadPermission,
  );
  return apiSuccess(dispute, correlationId);
});
