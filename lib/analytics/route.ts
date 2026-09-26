/**
 * Spec 040 §3.5 — the shared shape of the seven read-only report routes: session, the `default`
 * rate-limit bucket, the route's §3.7 permission, then the `from`/`to` window. No CSRF and no
 * `Idempotency-Key` — every route is a `GET`.
 */
import type { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { requireAnalyticsPermission, type AnalyticsAction } from './access';
import { parseReportRange, type ReportRange } from './range';

export function analyticsReportRoute(
  action: AnalyticsAction,
  respond: (range: ReportRange, params: URLSearchParams, correlationId: string) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return withApiRoute(async (request, correlationId) => {
    const session = await requireSession(request);
    const limit = checkRateLimit('default', session.userId);
    if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
    await requireAnalyticsPermission(session.userId, action);
    const params = new URL(request.url).searchParams;
    return respond(parseReportRange(params), params, correlationId);
  });
}
