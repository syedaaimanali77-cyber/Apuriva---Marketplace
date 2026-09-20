import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseSetPriorityRequest, requireSafetyResolvePermission, setSafetyPriority } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../../../safety-reports/report-id';

/**
 * Spec 030 §3, `POST /api/v1/admin/safety-reports/{id}/priority` — S11, DECIDED-1.
 *
 * THE ONLY WAY A PRIORITY EVER MOVES. Nothing derives a priority from a report's content, category,
 * target or reporter; every report is created at one constant and a human changes it here or not at
 * all. Without this route the "human-set priority" DECIDED-1 specifies would be unreachable, which
 * is why it exists even though §3's original table listed only S1–S10.
 *
 * Behind `safety_reports/resolve`, whose row in §3's permission table already reads "claiming,
 * priority change, resolution" — so no new permission is introduced.
 *
 * Audited as `safety.priority_changed` carrying BOTH values, so a later reader can see not just
 * what a report was rated but what it was rated before and who moved it.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireSafetyResolvePermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseSetPriorityRequest(body);

  const report = await setSafetyPriority({
    adminUserId: session.userId,
    reportId: safetyReportIdFromUrl(request, 1),
    priority: input.priority,
    expectedStatus: input.expectedStatus,
    correlationId,
  });

  return apiSuccess(report, correlationId);
});
