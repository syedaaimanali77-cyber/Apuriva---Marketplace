import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { claimSafetyReport, requireSafetyResolvePermission, parseTransitionRequest } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../../../safety-reports/report-id';

/**
 * Spec 030 §3, `POST /api/v1/admin/safety-reports/{id}/claim` — S8.
 *
 * Moves `submitted -> under_review` and records the claiming admin, so shared work has a visible
 * owner and two admins do not both start on the same report.
 *
 * A reason is NOT required: claiming changes nothing about the report's outcome, and demanding
 * prose before an admin may even start reading would be friction with no audit value. The claim is
 * still audited (`safety.report_claimed`).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireSafetyResolvePermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseTransitionRequest(body, false);

  const report = await claimSafetyReport({
    adminUserId: session.userId,
    reportId: safetyReportIdFromUrl(request, 1),
    expectedStatus: input.expectedStatus,
    reason: input.reason,
    correlationId,
  });

  return apiSuccess(report, correlationId);
});
