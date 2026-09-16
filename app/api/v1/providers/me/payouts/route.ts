import { withApiRoute } from '@/lib/api/handler';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged } from '@/lib/api/response';
import { listProviderPayouts } from '@/lib/payouts';
import { guardProviderPayoutRead } from '../../../payouts/route-guards';

/** Spec 024 §3.12, `GET /api/v1/providers/me/payouts?status=` — the caller's own payouts only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  const url = new URL(request.url);
  const { data, page } = await listProviderPayouts(providerProfileId, {
    page: parsePageParams(url.searchParams),
    status: url.searchParams.get('status'),
  });
  return apiPaged(data, page, correlationId);
});
