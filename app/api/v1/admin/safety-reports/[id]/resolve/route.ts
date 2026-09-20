import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { resolveSafetyReport, requireSafetyResolvePermission, parseTransitionRequest } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../../../safety-reports/report-id';

/**
 * Spec 030 §3, `POST /api/v1/admin/safety-reports/{id}/resolve` — S10, AC-3/AC-5.
 *
 * Behind `safety_reports/resolve` (`medium`). A reason is REQUIRED, and
 * `safety_reports_resolution_pairing_ck` makes a resolution without a named admin, an instant and a
 * reason PHYSICALLY UNREPRESENTABLE — so the guarantee holds even against a direct database write.
 *
 * `requestRestriction` asks SPEC 038 to restrict the reported account (DECIDED-3). This route
 * applies nothing itself: it calls `SafetyRestrictionGate`, which is unregistered until spec 038
 * ships and therefore throws `422 RESTRICTION_UNAVAILABLE`, leaving the report OPEN and the account
 * untouched. That refusal is deliberate — an admin who asked to restrict someone must never be left
 * believing it happened.
 *
 * `resolved` is terminal (DECIDED-4): a new concern produces a new report rather than re-opening a
 * closed safety finding.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireSafetyResolvePermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseTransitionRequest(body, true);

  const report = await resolveSafetyReport({
    adminUserId: session.userId,
    reportId: safetyReportIdFromUrl(request, 1),
    expectedStatus: input.expectedStatus,
    reason: input.reason,
    correlationId,
    requestRestriction: input.requestRestriction,
  });

  return apiSuccess(report, correlationId);
});
