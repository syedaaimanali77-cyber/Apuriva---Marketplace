import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listModerationQueue, requireReviewQueuePermission } from '@/lib/reviews';

/**
 * Spec 029 §3, `GET /api/v1/admin/reviews/moderation-queue` — AC-4, AC-9.
 *
 * Authorization is spec 009's existing `reviews/read_moderation_queue` at the `low` tier, seeded by
 * migration 0026 for Trust & Safety and Super Admin only. Master §69 scopes Content/Marketplace
 * Admin to services, categories and FAQs, so a review is not theirs; every other admin role gets
 * `403`, resolved server-side and logged by `withApiRoute`.
 *
 * WHAT THIS QUEUE IS, AND IS NOT. It is a work list: `flagged` reviews plus any review carrying an
 * `open` report, oldest-first. Everything in it is ALREADY PUBLICLY VISIBLE — appearing here is not
 * a consequence, it is a request for a human to look. Nothing is hidden by being listed.
 *
 * `AdminReviewDto` is the only projection carrying `flagSignals`, the moderation record and the
 * reports — and it still carries no reporter identity, because a reporter whose identity can leak
 * to the reviewed provider will not report.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireReviewQueuePermission(session.userId);

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const result = await listModerationQueue(page);

  return apiPaged(result.items, buildPage(result.total, page.limit, page.offset), correlationId);
});
