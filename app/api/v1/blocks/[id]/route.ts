import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { removeBlock } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../safety-reports/report-id';

/**
 * Spec 030 §3, `DELETE /api/v1/blocks/{id}` — S3, AC-1. Unblock.
 *
 * IDEMPOTENT: deleting a block that is not there is `204`, not `404`, because the caller's intent
 * ("I do not want this block") is already satisfied. A block id belonging to someone else is `404`
 * — never `403`, which would confirm it exists and let block ids be probed.
 *
 * Unblocking restores sending immediately: spec 025's gate reads `user_blocks` live on every send,
 * so there is no cache to invalidate and no second step.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await removeBlock(session.userId, safetyReportIdFromUrl(request));

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
