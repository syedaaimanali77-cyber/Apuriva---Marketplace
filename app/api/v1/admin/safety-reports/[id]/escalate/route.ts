import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { escalateSafetyReport, requireSafetyEscalatePermission, parseTransitionRequest } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../../../safety-reports/report-id';

/**
 * Spec 030 §3, `POST /api/v1/admin/safety-reports/{id}/escalate` — S9, master §64.
 *
 * Behind `safety_reports/escalate` (`medium`). A reason is REQUIRED (master §68): escalation moves
 * a report to a different set of eyes, and why it moved is the most useful thing the next reader
 * has.
 *
 * Escalation changes WHO LOOKS, never what happens to anyone. It applies no sanction and touches no
 * account — this spec has no path that could (DECIDED-3).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireSafetyEscalatePermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseTransitionRequest(body, true);

  const report = await escalateSafetyReport({
    adminUserId: session.userId,
    reportId: safetyReportIdFromUrl(request, 1),
    expectedStatus: input.expectedStatus,
    reason: input.reason,
    correlationId,
  });

  return apiSuccess(report, correlationId);
});
