import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { createReviewReport, parseCreateReportRequest } from '@/lib/reviews';
import { reviewIdFromUrl } from '../../review-id';

/**
 * Spec 029 §3, `POST /api/v1/reviews/{id}/reports` — AC-6.
 *
 * Any authenticated user, either mode — but not a guest: a report with no accountable author is an
 * unpriced denial-of-service on the moderation queue. Reporting your own review is
 * `422 CANNOT_REPORT_OWN_REVIEW`.
 *
 * WHAT A REPORT CANNOT DO. It never hides, removes, suppresses or down-weights the review. Its only
 * status effect is the widening one `published -> flagged`, which is publicly visible; no report
 * COUNT is consulted anywhere, so a brigade produces a queue entry rather than a takedown. Removal
 * requires `reviews_removal_pairing_ck`'s named human admin, instant and reason, which this path
 * has no way to supply.
 *
 * A repeat by the same reporter replays their existing report with `200` rather than erroring:
 * they own that row, so telling them it exists enumerates nothing, and an error would only teach
 * people to re-file under a second reason to be heard. `review_reports_review_reporter_uq` is what
 * makes that true under concurrency.
 *
 * Two independent limits apply: the `reviews` rate-limit domain bounds request RATE, and
 * `lib/reviews/report.ts`'s 20-reports-per-24-hours cap bounds sustained VOLUME.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseCreateReportRequest(body);

  const { report, replayed } = await createReviewReport(session.userId, reviewIdFromUrl(request, 1), input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(report, correlationId, { status: replayed ? 200 : 201 });
});
