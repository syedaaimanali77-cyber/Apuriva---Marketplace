import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { createReviewResponse, parseCreateResponseRequest } from '@/lib/reviews';
import { reviewIdFromUrl } from '../../review-id';

/**
 * Spec 029 §3, `POST /api/v1/reviews/{id}/response` — AC-3.
 *
 * OWNERSHIP IS PROVED TWICE, and no provider id ever comes from the client. `requireOwnProviderProfile`
 * proves the caller owns *a* provider profile; `createReviewResponse` then proves that profile is
 * the one the review is ABOUT, by comparing it with `reviews.provider_profile_id` — which was itself
 * copied from the booking. A provider who owns a different profile gets `404`, indistinguishable
 * from a review that does not exist, so review ids cannot be probed.
 *
 * EXACTLY ONE RESPONSE, and it is never revised: there is no PATCH and no DELETE here.
 * `review_responses_review_id_uq` decides the race between two concurrent posts, so the loser gets
 * `409 RESPONSE_ALREADY_EXISTS` rather than silently replacing the first.
 *
 * `Idempotency-Key` is REQUIRED, for the same reason spec 028's milestones route requires one:
 * repeating this POST would otherwise surface as a `409` on an honest client retry.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  const profile = await requireOwnProviderProfile(session.userId);

  const limit = checkRateLimit('reviews', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseCreateResponseRequest(body);

  const { response, replayed } = await createReviewResponse(
    session.userId,
    profile.id,
    reviewIdFromUrl(request, 1),
    input,
    { key, fingerprint: idempotencyFingerprint(input) },
  );

  return apiSuccess(response, correlationId, { status: replayed ? 200 : 201 });
});
