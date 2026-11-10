import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { reopenTicketAsRequester } from '@/lib/support';
import { supportTicketIdFromUrl } from '../../../support-id';

/**
 * Spec 032 §3, `POST /api/v1/support/tickets/{id}/reopen` — the requester's ONE reopen.
 *
 * Capped at one (`MAX_REQUESTER_REOPENS`) and bounded by `SUPPORT_REOPEN_WINDOW_DAYS`, for spec
 * 031's one-appeal reason: an unbounded reopen makes `closed` unreachable, and a ticket that can
 * never end is one nobody can be accountable for. Past the cap is `409`; past the window is `422`
 * — two different problems with two different answers, so the UI can say which.
 *
 * Reopening WITHDRAWS the resolution rather than keeping it alongside a live ticket:
 * `support_tickets_resolution_pairing_ck` requires kind, reason and instant to move together.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticket = await reopenTicketAsRequester(session.userId, supportTicketIdFromUrl(request, 1));
  return apiSuccess(ticket, correlationId);
});
