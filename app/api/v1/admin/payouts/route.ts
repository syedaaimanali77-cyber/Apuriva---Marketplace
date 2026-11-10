import { withApiRoute } from '@/lib/api/handler';
import { parsePageParams } from '@/lib/api/pagination';
import { apiPaged } from '@/lib/api/response';
import { listAdminPayouts, PAYOUTS_READ_ACTION, requirePayoutPermission } from '@/lib/payouts';
import { isValidIsoDate } from '@/lib/payouts/read';
import { validationError } from '@/lib/api/errors';
import { guardAdminPayoutRequest } from '../../payouts/route-guards';

function instant(value: string | null, field: string, endOfDay: boolean): Date | null {
  if (value === null || value === '') return null;
  if (!isValidIsoDate(value)) throw validationError([{ field, message: 'must be a date (YYYY-MM-DD)' }]);
  const date = new Date(`${value}T00:00:00Z`);
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

/**
 * Spec 024 §3.12, `GET /api/v1/admin/payouts?status=&providerProfileId=&from=&to=` — requires
 * `payouts/read` (Finance and Super Admins only). Failed and escalated payouts sort first. Admin date
 * filters are UTC calendar dates; no single provider timezone applies across providers.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminPayoutRequest(request, { csrf: false });
  await requirePayoutPermission(userId, PAYOUTS_READ_ACTION);
  const url = new URL(request.url);
  const { data, page } = await listAdminPayouts({
    page: parsePageParams(url.searchParams),
    status: url.searchParams.get('status'),
    providerProfileId: url.searchParams.get('providerProfileId'),
    range: {
      fromInstant: instant(url.searchParams.get('from'), 'from', false),
      toInstant: instant(url.searchParams.get('to'), 'to', true),
    },
  });
  return apiPaged(data, page, correlationId);
});
