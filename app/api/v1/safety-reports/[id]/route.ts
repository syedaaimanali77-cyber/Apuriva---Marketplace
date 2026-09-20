import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getSafetyReportForReporter } from '@/lib/safety';
import { safetyReportIdFromUrl } from '../report-id';

/**
 * Spec 030 §3, `GET /api/v1/safety-reports/{id}` — S5, AC-3.
 *
 * THE REPORTER'S OWN RESTRICTED VIEW. It carries `id`, `status`, `category`, `createdAt` and their
 * own attachments — and deliberately NOT `priority`, `aiSummary`, any admin identity or the
 * resolution reason. A reporter learning their report was triaged `low` would be told about the
 * platform's internal judgement, not about themselves. That narrowing is structural, not a runtime
 * filter: `toSafetyReportDto` never receives those columns (see `lib/safety/rows.ts`).
 *
 * Anyone who is not the reporter gets `404`, never `403` — including the reported user, and
 * including an admin, who has their own route. `403` would confirm the report exists, which on a
 * safety surface tells a reported user they were reported.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const report = await getSafetyReportForReporter(session.userId, safetyReportIdFromUrl(request));
  return apiSuccess(report, correlationId);
});
