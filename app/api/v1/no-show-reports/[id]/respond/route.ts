import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { forbiddenError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { respondToNoShow } from '@/lib/no-show';

const MAX_STATEMENT_LENGTH = 4000;

function reportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 023 §3, `POST /api/v1/no-show-reports/{id}/respond` — AC-5's other half.
 *
 * This is the step that makes a consequence possible at all: until the other party responds (or
 * their window elapses), no admin can resolve the report and nothing can happen to anyone.
 *
 * Naturally single-shot — a second response is `409 NO_SHOW_RESPONSE_ALREADY_FILED` — so no
 * `Idempotency-Key` is required; there is no way for a retry to produce two responses.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') throw forbiddenError('This action requires customer or provider mode.');

  const limit = checkRateLimit('bookings', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const raw = (await request.json().catch(() => null)) as { statement?: unknown } | null;
  const statement = raw?.statement;
  if (statement !== undefined && (typeof statement !== 'string' || statement.length > MAX_STATEMENT_LENGTH)) {
    throw validationError([
      { field: 'statement', message: `must be a string of at most ${MAX_STATEMENT_LENGTH} characters` },
    ]);
  }

  const report = await respondToNoShow({
    userId: session.userId,
    reportId: reportIdFromUrl(request),
    statement: statement as string | undefined,
  });
  return apiSuccess(report, correlationId);
});
