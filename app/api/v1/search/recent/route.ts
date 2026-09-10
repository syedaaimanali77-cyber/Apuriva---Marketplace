import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { recordRecentSearch } from '@/lib/search/recent';
import type { RecordRecentSearchRequest } from '@/lib/types/search';

/** Spec 013 §3, `POST /api/v1/search/recent` — records a search to the caller's own
 * recent-searches list; session required. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<RecordRecentSearchRequest>;
  await recordRecentSearch(session.userId, body);

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
