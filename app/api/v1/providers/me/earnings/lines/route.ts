import { withApiRoute } from '@/lib/api/handler';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged } from '@/lib/api/response';
import { listEarningsLines, parseCurrency, resolveDateRange } from '@/lib/payouts';
import { guardProviderPayoutRead } from '../../../../payouts/route-guards';

/** Spec 024 §3.12, `GET /api/v1/providers/me/earnings/lines` — booking-level detail (AC-3). */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  const url = new URL(request.url);
  const range = await resolveDateRange(providerProfileId, url.searchParams.get('from'), url.searchParams.get('to'));
  const { data, page } = await listEarningsLines(providerProfileId, {
    page: parsePageParams(url.searchParams),
    state: url.searchParams.get('state'),
    currency: parseCurrency(url.searchParams.get('currency')),
    range,
  });
  return apiPaged(data, page, correlationId);
});
