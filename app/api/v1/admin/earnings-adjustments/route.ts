import { withApiRoute } from '@/lib/api/handler';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import {
  executeEarningsAdjustment,
  initiateEarningsAdjustment,
  listAdminAdjustments,
  PAYOUTS_READ_ACTION,
  requirePayoutPermission,
} from '@/lib/payouts';
import { guardAdminPayoutRequest, payoutIdempotencyKey } from '../../payouts/route-guards';

/**
 * Spec 024 §3.10, `POST /api/v1/admin/earnings-adjustments` — AC-9, seeded `payouts/adjust` at `high`.
 *
 *   - INITIATE (no `adminActionId`): writes an UNAPPLIED row with immutable figures bound to a new
 *     `Pending` AdminAction. It counts in no figure until approved and executed. `202`.
 *   - EXECUTE (`adminActionId`, and deliberately NO amount): sets `applied_at` on exactly the approved
 *     row, after spec 009's `executeApprovedAction`. `201`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminPayoutRequest(request);
  const idempotencyKey = payoutIdempotencyKey(request);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (typeof body.adminActionId === 'string' && body.adminActionId.length > 0) {
    const adjustment = await executeEarningsAdjustment({ adminUserId: userId, adminActionId: body.adminActionId });
    return apiSuccess(adjustment, correlationId, { status: 201 });
  }

  const result = await initiateEarningsAdjustment({ adminUserId: userId, idempotencyKey, body });
  return apiSuccess(result.pending, correlationId, { status: result.replayed ? 200 : 202 });
});

/** Spec 024 §3.12, `GET /api/v1/admin/earnings-adjustments?providerProfileId=&applied=` — `payouts/read`. */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminPayoutRequest(request, { csrf: false });
  await requirePayoutPermission(userId, PAYOUTS_READ_ACTION);
  const url = new URL(request.url);
  const { data, page } = await listAdminAdjustments({
    page: parsePageParams(url.searchParams),
    providerProfileId: url.searchParams.get('providerProfileId'),
    applied: url.searchParams.get('applied'),
  });
  return apiPaged(data, page, correlationId);
});
