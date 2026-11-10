/**
 * Spec 029 — the public face of `lib/reviews`, and the spec's composition-root registration.
 *
 * `registerReviewsIntegration()` makes two ports real that shipped inert on purpose:
 *   - spec 027's `review_media` file context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`);
 *   - spec 017's `ProviderRatingSource` (default: `null` for every provider, i.e. the `rating`
 *     factor excluded from scoring — spec 017's behaviour before this spec existed).
 *
 * It must run AFTER spec 027, which resets and registers its own shipped policies. Rolling spec 029
 * back returns both ports to those documented defaults, so no shipped spec breaks.
 *
 * NOTE what is NOT here: no notification port (spec 026 already ships, so `notify()` is called
 * directly, as specs 015 and 016 do) and no booking transition (this spec performs none — it reads
 * `bookings_status_history` and nothing else).
 */
import { registerProviderRatingSource, resetProviderRatingSource } from '@/lib/matching/rating-source';
import { registerFileContextPolicy } from '@/lib/files/contexts/registry';
import { getProviderRatingAggregates } from './aggregate';
import { MAX_RATING, MIN_RATING, REVIEW_MEDIA_CONTEXT } from './limits';
import { reviewMediaPolicy } from './media-policy';

export { createReview } from './create';
export { createReviewResponse } from './response';
export { createReviewReport, listReportsFiledBy, loadReportsForReviews } from './report';
export { listModerationQueue, resolveReviewModeration, REVIEW_MODERATION_EVENT_TYPE } from './moderation';
export { getBookingReviewState, listProviderReviews, loadReviewRow, requireReviewRow } from './read';
export { getProviderRatingAggregate, getProviderRatingAggregates } from './aggregate';
export { resolveReviewEligibility, type ReviewEligibility } from './eligibility';
export { evaluateReviewSignals, type ReviewSignalResult } from './signals';
export { normalizeReviewText } from './validation';
export {
  parseCreateReportRequest,
  parseCreateResponseRequest,
  parseCreateReviewRequest,
  parseResolveReviewRequest,
} from './validation';
export { requireReviewModeratePermission, requireReviewQueuePermission } from './permissions';
export { reviewMediaPolicy, registerReviewMediaContext } from './media-policy';
export {
  MAX_REVIEW_MEDIA,
  MAX_TEXT_LENGTH,
  MIN_TEXT_LENGTH,
  MAX_RATING,
  MIN_RATING,
  REVIEW_MEDIA_CONTEXT,
  reviewWindowDays,
} from './limits';

/**
 * Spec 017 consumes a NORMALIZED 0..1 factor, not a 1..5 star average: `scoreProvider` multiplies
 * each factor by its weight and expects every factor on the same scale. The mapping is linear over
 * the rating range, so 1 star is 0 and 5 stars is 1 — done here, in spec 029's own module, because
 * how a rating becomes a ranking input is this spec's arithmetic to own, not spec 017's to learn.
 */
function normalizeRating(average: number): number {
  return Math.min(1, Math.max(0, (average - MIN_RATING) / (MAX_RATING - MIN_RATING)));
}

/** Called from `instrumentation.ts` — the composition root specs 021–028 already use. */
export function registerReviewsIntegration(): void {
  registerFileContextPolicy(REVIEW_MEDIA_CONTEXT, reviewMediaPolicy);

  registerProviderRatingSource(async (providerProfileIds) => {
    const aggregates = await getProviderRatingAggregates(providerProfileIds);
    const result = new Map<string, number | null>();
    for (const [providerProfileId, aggregate] of aggregates) {
      // A provider with zero visible reviews is absent from `aggregates` entirely, so they stay
      // absent here too — "not yet rated", not "rated zero".
      if (aggregate.count > 0) result.set(providerProfileId, normalizeRating(aggregate.average));
    }
    return result;
  });
}

/** Returns spec 017's port to its documented pre-029 default. For tests, and for rollback parity. */
export function resetReviewsIntegration(): void {
  resetProviderRatingSource();
}
