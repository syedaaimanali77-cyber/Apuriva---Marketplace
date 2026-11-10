import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { listProviderReviews } from '@/lib/reviews';
import { segmentFromUrl } from '../../path-params';

/**
 * Spec 029 §3, `GET /api/v1/providers/{id}/reviews` — session or guest, AC-4, AC-5.
 *
 * THE ROUTE AC-4 AND AC-5 ARE OBSERVED THROUGH. It returns `published` **and** `flagged` reviews,
 * and `PublicReviewDto` carries no `status` field at all — so a flagged review is byte-for-byte
 * indistinguishable from a published one here. There is therefore no channel through which a
 * heuristic's suspicion could reach a reader as a verdict, and a legitimate one-star review that
 * matched no signal is simply a review.
 *
 * `removed` reviews are excluded, and so is their media: `loadReviewRelations` only attaches `ready`
 * assets, and spec 027 re-runs `canRead` on every URL issue, where `reviewMediaPolicy` consults the
 * owning review's status. Removing a review takes its photographs down in the same act.
 *
 * NO REVIEWER IDENTITY IS RETURNED. This repository has no customer display-name field anywhere, so
 * there is nothing to expose even if the product wanted it (spec 029 §8 question 3).
 *
 * Rate-limited by session user id, or by `hashRequestIp()` for a guest — the shape spec 016's public
 * availability route established, so the public list cannot be scraped at `default` speed.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';

  const limit = checkRateLimit('reviews', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const page = parsePageParams(url.searchParams);

  // .../providers/{id}/reviews
  const result = await listProviderReviews(segmentFromUrl(request, 1), page);

  return apiPaged(result.items, buildPage(result.total, page.limit, page.offset), correlationId);
});
