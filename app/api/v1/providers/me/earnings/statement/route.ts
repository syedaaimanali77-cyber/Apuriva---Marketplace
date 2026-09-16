import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { buildStatement } from '@/lib/payouts';
import { guardProviderPayoutRead } from '../../../../payouts/route-guards';

/**
 * Spec 024 §3.11, `GET /api/v1/providers/me/earnings/statement?from=&to=&currency=` — AC-6.
 *
 * Synchronous, bounded CSV using spec 008's non-envelope response idiom (the data-export download
 * route): a `text/csv` body on success, the standard `ApiError` envelope on failure. Nothing is
 * stored, so there is no artifact or download token to leak.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  const url = new URL(request.url);
  const statement = await buildStatement(providerProfileId, {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    currency: url.searchParams.get('currency'),
  });

  const res = new NextResponse(statement.body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${statement.filename}"`,
      'cache-control': 'private, no-store',
    },
  });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
