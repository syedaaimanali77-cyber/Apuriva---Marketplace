import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { createSafetyReport, parseCreateSafetyReportRequest } from '@/lib/safety';

/**
 * Spec 030 §3, `POST /api/v1/safety-reports` — S4, AC-2.
 *
 * Any authenticated user, either mode — but not a guest: a report with no accountable author is an
 * unpriced denial-of-service on a SAFETY queue, which is the worst possible queue to flood.
 * Reporting yourself is `422 CANNOT_REPORT_SELF`, and `safety_reports_no_self_ck` makes it
 * unrepresentable at the database too.
 *
 * THE BODY CARRIES NO PRIORITY (DECIDED-1). A reporter cannot set their own triage level, and
 * nothing derives one from `category` — every report is created at the same constant and only a
 * Trust & Safety admin moves it. That is what "no automated classification" means concretely.
 *
 * The reported user is never notified, here or anywhere (master §64).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseCreateSafetyReportRequest(body);

  const { report, replayed } = await createSafetyReport(session.userId, input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(report, correlationId, { status: replayed ? 200 : 201 });
});
