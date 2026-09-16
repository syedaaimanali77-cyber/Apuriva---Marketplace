import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { executePayoutRetry, initiatePayoutRetry } from '@/lib/payouts';
import { guardAdminPayoutRequest, pathSegment, payoutIdempotencyKey, withPayoutProviderGuard } from '../../../../payouts/route-guards';

/**
 * Spec 024 §3.8, `POST /api/v1/admin/payouts/{id}/retry` — a "payout intervention" (master spec §70),
 * seeded `payouts/retry` at risk tier `high`. Two shapes, spec 022's idiom:
 *
 *   - INITIATE (no `adminActionId`, `reason` required): creates a `Pending` AdminAction awaiting a
 *     SECOND, distinct admin. The payout does not change. `202`.
 *   - EXECUTE (`adminActionId`): only after spec 009's `executeApprovedAction` confirms approval,
 *     `failed → eligible` with a re-snapshotted payout method. `200`.
 *
 * No transfer happens in this route: the payout sweep claims the reopened payout under its own lock.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminPayoutRequest(request);
  payoutIdempotencyKey(request);
  const payoutId = pathSegment(request, 2);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.adminActionId === 'string' && body.adminActionId.length > 0) {
    const payout = await withPayoutProviderGuard(() =>
      executePayoutRetry({ adminUserId: userId, payoutId, adminActionId: body.adminActionId as string }),
    );
    return apiSuccess(payout, correlationId);
  }

  const pending = await initiatePayoutRetry({ adminUserId: userId, payoutId, body });
  return apiSuccess(pending, correlationId, { status: 202 });
});
