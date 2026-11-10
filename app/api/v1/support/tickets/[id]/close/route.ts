import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { closeTicketAsRequester } from '@/lib/support';
import { supportTicketIdFromUrl } from '../../../support-id';

/**
 * Spec 032 §3, `POST /api/v1/support/tickets/{id}/close` — the requester accepting the resolution.
 *
 * `closed` IS TERMINAL. There is no route anywhere in this spec that leaves it, and the transition
 * table has no row with `closed` as a `from`, so this is a one-way door for the user as much as for
 * an admin. A new matter is a new ticket, which is also what keeps each ticket's audit trail about
 * one thing.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticket = await closeTicketAsRequester(session.userId, supportTicketIdFromUrl(request, 1));
  return apiSuccess(ticket, correlationId);
});
