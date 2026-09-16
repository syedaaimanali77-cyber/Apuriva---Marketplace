import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { loadAdminPayoutDetail, PAYOUTS_READ_ACTION, requirePayoutPermissionOrNotFound } from '@/lib/payouts';
import { guardAdminPayoutRequest, pathSegment } from '../../../payouts/route-guards';

/**
 * Spec 024 §3.12, `GET /api/v1/admin/payouts/{id}` — an admin without `payouts/read` gets
 * `404 PAYOUT_NOT_FOUND`, indistinguishable from a missing id (AC-13). Never a rail reference or token.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminPayoutRequest(request, { csrf: false });
  await requirePayoutPermissionOrNotFound(userId, PAYOUTS_READ_ACTION);
  return apiSuccess(await loadAdminPayoutDetail(pathSegment(request, 1)), correlationId);
});
