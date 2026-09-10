import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { parsePageParams, buildPage } from '@/lib/api/pagination';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { searchServices, type SearchParams } from '@/lib/search/query';
import type { SearchSort } from '@/lib/types/search';

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Spec 013 §3, `GET /api/v1/search` — the sole authoritative results endpoint (AC-1/AC-6).
 * Guest-accessible; never calls `lib/ai`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('search', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const searchParams = new URL(request.url).searchParams;
  const page = parsePageParams(searchParams);

  const params: SearchParams = {
    q: searchParams.get('q') ?? undefined,
    serviceId: searchParams.get('serviceId') ?? undefined,
    categoryId: searchParams.get('categoryId') ?? undefined,
    lat: numberParam(searchParams.get('lat')),
    lng: numberParam(searchParams.get('lng')),
    radiusKm: numberParam(searchParams.get('radiusKm')),
    budgetMaxMinorUnits: numberParam(searchParams.get('budgetMaxMinorUnits')),
    date: searchParams.get('date') ?? undefined,
    sort: (searchParams.get('sort') as SearchSort | null) ?? undefined,
  };

  const { items, total } = await searchServices(params, page);
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
