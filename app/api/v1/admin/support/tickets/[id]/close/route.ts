import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { closeTicketAsAdmin, requireSupportResolvePermission } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3, `POST /api/v1/admin/support/tickets/{id}/close`.
 *
 * NOTIFIES NOBODY, deliberately. The requester was already told at resolution, and closure asks
 * nothing further of them — a second push saying "and now it is really finished" would be noise.
 *
 * `closed` is terminal: no route in this spec leaves it, for any actor including `super_admin`.
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

  const ticket = await closeTicketAsAdmin({ adminUserId: session.userId, ticketId, correlationId });
  return apiSuccess(ticket, correlationId);
});
