import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { loadProviderPayoutDetail } from '@/lib/payouts';
import { guardProviderPayoutRead, pathSegment } from '../../../../payouts/route-guards';

/**
 * Spec 024 §3.12, `GET /api/v1/providers/me/payouts/{id}` — scoped by the caller's own provider
 * profile, so another provider's payout id is `404 PAYOUT_NOT_FOUND`, never `403` (AC-13).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  return apiSuccess(await loadProviderPayoutDetail(providerProfileId, pathSegment(request, 1)), correlationId);
});
