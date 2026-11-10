import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { completeBooking, MAX_BOOKING_EVIDENCE_ASSETS } from '@/lib/bookings';
import type { CompleteBookingRequest } from '@/lib/types/bookings';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Spec 020 §3, `POST /api/v1/bookings/{id}/complete` — AC-5, AC-8, AC-9, AC-10, AC-11.
 *
 * AC-8, unchanged: **either** the customer **or** the provider may mark an `in_progress` booking
 * complete, with equal authority and **without the other party's confirmation**. This route asks
 * for no agreement, waits for nothing, and has no confirmation parameter.
 *
 * It is the one route open to either active mode. The mode selects which participant the caller is
 * acting as, and `completeBooking` requires the caller genuinely to be that party — so a user who
 * holds both a customer and a provider profile on one booking can never write an ambiguous
 * `actor_role` (§3 "Authorization matrix").
 *
 * Validation order is normative (AC-9) and starts here: (1) session, (2) CSRF, then (3) participant
 * + mode match, (4) `Idempotency-Key`, (5) status, (6) dwell, (7) evidence gate, (8) the
 * concurrency-safe transition — the last five inside `completeBooking`. A request failing any of
 * (1)–(7) is rejected on its own merits even if the other party's concurrent request already
 * completed the booking.
 *
 * SPEC 028 EXTENSION (§3 "The one change to a spec 020 file"). The body now carries the one
 * OPTIONAL field spec 020 §3 reserved for spec 028: `evidenceFileAssetIds`. Everything above is
 * unchanged — same route, method, auth rules, idempotency requirement and validation order — and a
 * body without the field behaves exactly as it did before, so this is purely additive.
 *
 * The field is NEVER authoritative. Each id must already be a live `ready` `booking_evidence` asset
 * of THIS booking or the whole request is `422 EVIDENCE_ASSET_INVALID`; whether the requirement is
 * met is counted server-side from the database, from `services.completion_evidence_required` joined
 * through `bookings.service_id`. Nothing a client sends can create, weaken or skip the requirement
 * (spec 028 AC-4/AC-6).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  // Required so a retried completion is a replay, never a second attribution (safeguard S9).
  requireIdempotencyKey(request);

  const body = (await request.json().catch(() => ({}))) as CompleteBookingRequest;
  // Shape only. Whether these ids are *valid evidence for this booking* is decided server-side,
  // under the completion lock, by `assertEvidenceAssetsBelongToBooking` (spec 028 AC-6).
  const evidenceFileAssetIds = parseEvidenceIds(body.evidenceFileAssetIds);

  const booking = await completeBooking(session.userId, bookingIdFromUrl(request, 1), mode, evidenceFileAssetIds);
  return apiSuccess(booking, correlationId);
});

/** An absent field and an empty list mean the same thing: the caller declared no evidence. */
function parseEvidenceIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw validationError([{ field: 'evidenceFileAssetIds', message: 'must be an array of file asset ids' }]);
  }
  if (value.length > MAX_BOOKING_EVIDENCE_ASSETS) {
    throw validationError([
      { field: 'evidenceFileAssetIds', message: `must contain at most ${MAX_BOOKING_EVIDENCE_ASSETS} ids` },
    ]);
  }
  return value as string[];
}
