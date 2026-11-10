import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseResolveReviewRequest, requireReviewModeratePermission, resolveReviewModeration } from '@/lib/reviews';
import { reviewIdFromUrl } from '../../../../reviews/review-id';

/**
 * Spec 029 §3, `POST /api/v1/admin/reviews/{id}/resolve` — AC-4, AC-5, AC-8, AC-9.
 *
 * THE ONLY ROUTE IN THE REPOSITORY THAT CAN HIDE A REVIEW. Everything else in this spec — the
 * rule-based signals, a user report, a report count — can at most move a review to `flagged`, which
 * is publicly visible. `removed` exists on one code path, behind one permission, and the database's
 * `reviews_removal_pairing_ck` refuses any removal that does not carry a named admin profile, an
 * instant and a recorded reason. So AC-4's "never automatically removed" is not a promise about
 * this route's discipline; it is a property of the schema.
 *
 * The body is deliberately narrow: a `decision` from a CLOSED set, a required `reason` (master §68),
 * and the `expectedStatus` the admin was shown. There is no free-form status field and no
 * visibility toggle — an admin decides WHAT HAPPENED, never what the row says. `expectedStatus`
 * gives the optimistic concurrency `applyBookingTransition()` uses, so two admins resolving the
 * same review simultaneously cannot silently overwrite each other; the loser gets `409 CONFLICT`
 * carrying the current status.
 *
 * `reinstate` is master §68's required appeal mechanism: a removal is reversible, by the same
 * permission, with its own audit entry.
 *
 * Authorization is `reviews/moderate` at the `medium` tier — one authorized admin plus reason and
 * audit (master §70). No `AdminAction` row and no four-eyes framework, the call spec 023 already
 * made for `no_show_reports/resolve`. Every decision writes one `recordAdminAuditEvent` INSIDE the
 * transaction: if the audit write fails, the status does not change.
 *
 * No `Idempotency-Key`: the operation is naturally idempotent under `expectedStatus`, exactly as
 * spec 020's lifecycle routes are under their expected status.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireReviewModeratePermission(session.userId);

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const { decision, reason, expectedStatus } = parseResolveReviewRequest(body);

  const review = await resolveReviewModeration({
    adminUserId: session.userId,
    reviewId: reviewIdFromUrl(request, 1),
    decision,
    reason,
    expectedStatus,
    correlationId,
  });

  return apiSuccess(review, correlationId);
});
