import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getTicketForRequester } from '@/lib/support';
import { supportTicketIdFromUrl } from '../../support-id';

/**
 * Spec 032 §3, `GET /api/v1/support/tickets/{id}` — the requester's own ticket (AC-3).
 *
 * A NON-REQUESTER GETS `404`, NEVER `403`. A `403` would confirm the id exists, which is itself
 * information about someone else's problem. `loadOwnTicketRow` scopes on `requester_user_id` in the
 * query, so "not found" and "not yours" are the same query returning no rows — they cannot diverge.
 *
 * The payload is the participant projection: no assigned admin, no AI summary, no SLA clock, no
 * legal hold, no escalation pointer id and no idempotency column. Those fields do not exist on
 * `SupportTicketDto` at all, so no change here can start leaking one.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticket = await getTicketForRequester(session.userId, supportTicketIdFromUrl(request));
  return apiSuccess(ticket, correlationId);
});
