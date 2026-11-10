import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseResolveRequest, requireSupportResolvePermission, resolveTicket } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3, `POST /api/v1/admin/support/tickets/{id}/resolve` — AC-9.
 *
 * A REASON IS MANDATORY (10–2000 characters), because the requester is shown it. Master §2.3's
 * rule: a user is entitled to the reasoning behind a decision about them, not just its outcome.
 *
 * A `safety` TICKET CANNOT BE RESOLVED `answered`. `assertResolutionAllowed()` refuses it with an
 * explanation and `support_tickets_safety_resolution_ck` refuses the same write at the database —
 * the application check exists to explain, the constraint exists to guarantee. Support hands a
 * safety matter to spec 030 or records it as not actionable; it never adjudicates one.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const ticketId = supportTicketIdFromUrl(request, 1);
  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportResolvePermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const ticket = await resolveTicket({
    adminUserId: session.userId,
    ticketId,
    request: parseResolveRequest(body),
    correlationId,
  });
  return apiSuccess(ticket, correlationId);
});
