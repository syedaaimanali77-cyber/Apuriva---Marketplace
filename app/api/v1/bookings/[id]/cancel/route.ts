import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { cancelBookingAsParticipant } from '@/lib/cancellation';
import type { CancelBookingRequest } from '@/lib/types/cancellation';
import { bookingIdFromUrl } from '../../booking-id';

/**
 * Fields a client might try to send to decide its own fee. Every one of them is computed
 * server-side from the booking's snapshotted policy version, so their PRESENCE is itself the error
 * (AC-3) — silently ignoring them would leave a caller believing they had set a price.
 */
const FORBIDDEN_FIELDS = [
  'feeAmountMinorUnits',
  'refundAmountMinorUnits',
  'capturedAmountMinorUnits',
  'feePercent',
  'tier',
  'hoursBefore',
  'cancelledAt',
  'policyVersionId',
  'currencyCode',
] as const;

const MAX_NOTE_LENGTH = 2000;
const MAX_REASON_CODE_LENGTH = 64;

function parseBody(raw: unknown): CancelBookingRequest {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError([{ field: 'body', message: 'must be an object' }]);
  }
  const body = raw as Record<string, unknown>;

  const offending = FORBIDDEN_FIELDS.filter((field) => body[field] !== undefined);
  if (offending.length > 0) {
    throw validationError(
      offending.map((field) => ({
        field,
        message: 'is not accepted: the cancellation consequence is calculated by the server',
      })),
    );
  }

  const errors: { field: string; message: string }[] = [];
  if (body.reasonCode !== undefined) {
    if (typeof body.reasonCode !== 'string' || body.reasonCode.length > MAX_REASON_CODE_LENGTH) {
      errors.push({ field: 'reasonCode', message: `must be a string of at most ${MAX_REASON_CODE_LENGTH} characters` });
    }
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_LENGTH) {
      errors.push({ field: 'note', message: `must be a string of at most ${MAX_NOTE_LENGTH} characters` });
    }
  }
  if (errors.length > 0) throw validationError(errors);

  return { reasonCode: body.reasonCode as string | undefined, note: body.note as string | undefined };
}

/**
 * Spec 023 §3, `POST /api/v1/bookings/{id}/cancel` — AC-3, AC-7, AC-8.
 *
 * Guard order is normative and identical to every other financially consequential route in this
 * repository: (1) session, (2) CSRF, (3) active mode, (4) rate limit, (5) `Idempotency-Key`, then
 * participation, state, policy and the computation inside the domain layer.
 *
 * Either participant may cancel, in their own mode; the mode selects which party the caller is
 * acting as, and the domain layer requires them genuinely to be that party, so a user holding both
 * profiles on one booking can never write an ambiguous attribution.
 *
 * The key makes a retry a replay rather than a second cancellation — which matters here more than
 * almost anywhere, because a second cancellation would mean a second refund decision.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);
  const body = parseBody(await request.json().catch(() => null));

  const cancellation = await cancelBookingAsParticipant(
    session.userId,
    bookingIdFromUrl(request, 1),
    mode,
    idempotencyKey,
    body,
  );
  return apiSuccess(cancellation, correlationId);
});
