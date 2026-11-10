import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getSafetyReportForAdmin, requireSafetyReadPermission } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../../../safety-reports/report-id';

/**
 * Spec 030 §3, `GET /api/v1/admin/safety-reports/{id}` — S7, AC-3.
 *
 * A detail route distinct from the queue so the two reads are audited distinctly: "someone scanned
 * the queue" and "someone opened this person's report" are different facts about different people,
 * and collapsing them would make the trail useless for the second.
 *
 * Returns the full `AdminSafetyReportDto`, including `aiSummary` — which the UI renders under an
 * explicit "AI suggestion, not a decision" heading (AC-4). Nothing in this path reads it.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireSafetyReadPermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const report = await getSafetyReportForAdmin(session.userId, safetyReportIdFromUrl(request), correlationId);
  return apiSuccess(report, correlationId);
});
