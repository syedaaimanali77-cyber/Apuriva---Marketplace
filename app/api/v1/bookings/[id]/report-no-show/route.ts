import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { reportNoShow } from '@/lib/no-show';
import { bookingIdFromUrl } from '../../booking-id';

const MAX_STATEMENT_LENGTH = 4000;

/**
 * Spec 023 §3, `POST /api/v1/bookings/{id}/report-no-show` — AC-5.
 *
 * Filing a report has NO consequence: no money moves, the booking does not change status, and
 * nobody is blamed. It records the claim, gathers the evidence the platform already holds, and asks
 * the other party to respond. Only a Trust & Safety admin can ever decide an outcome.
 *
 * The body carries a statement and nothing else — no outcome, no accusation field, no location. A
 * reporter cannot pre-judge their own report through this API because there is no parameter with
 * which to do so.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const idempotencyKey = requireIdempotencyKey(request);

  const raw = (await request.json().catch(() => null)) as { statement?: unknown } | null;
  const statement = raw?.statement;
  if (statement !== undefined && (typeof statement !== 'string' || statement.length > MAX_STATEMENT_LENGTH)) {
    throw validationError([
      { field: 'statement', message: `must be a string of at most ${MAX_STATEMENT_LENGTH} characters` },
    ]);
  }

  const report = await reportNoShow({
    userId: session.userId,
    bookingId: bookingIdFromUrl(request, 1),
    mode,
    idempotencyKey,
    statement: statement as string | undefined,
  });
  return apiSuccess(report, correlationId, { status: 201 });
});
