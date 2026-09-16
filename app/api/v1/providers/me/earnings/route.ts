import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { earningsSummary, parseCurrency, resolveDateRange } from '@/lib/payouts';
import { guardProviderPayoutRead } from '../../../payouts/route-guards';

/**
 * Spec 024 §3.12, `GET /api/v1/providers/me/earnings` — AC-3. Every figure is a server-side SUM over
 * persisted integers; `from`/`to` are optional local dates in the provider's scheduling timezone.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  const url = new URL(request.url);
  const range = await resolveDateRange(providerProfileId, url.searchParams.get('from'), url.searchParams.get('to'));
  const summary = await earningsSummary(providerProfileId, { currency: parseCurrency(url.searchParams.get('currency')), range });
  return apiSuccess(summary, correlationId);
});
