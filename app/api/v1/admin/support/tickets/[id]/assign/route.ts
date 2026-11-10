import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { assignTicket, parseAssignRequest, requireSupportAssignPermission } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3, `POST /api/v1/admin/support/tickets/{id}/assign` — claim or reassign.
 *
 * THE SLA DEADLINE IS NOT RESET. A new assignee inherits the original one: if handing a ticket to a
 * colleague restarted its clock, passing it around would be a way to erase a breach. That is
 * asserted directly in `lib/support/sla.integration.test.ts`.
 *
 * The TARGET must hold `support/respond`, or this is `422 SUPPORT_ASSIGNEE_NOT_ELIGIBLE` — assigning
 * to someone who cannot reply would produce a ticket nobody can answer.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const ticketId = supportTicketIdFromUrl(request, 1);
  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportAssignPermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const ticket = await assignTicket({
    adminUserId: session.userId,
    ticketId,
    request: parseAssignRequest(body),
    correlationId,
  });
  return apiSuccess(ticket, correlationId);
});
