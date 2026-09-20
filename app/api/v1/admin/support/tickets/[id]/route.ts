import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getTicketForAdmin, requireSupportReadPermission } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../support/support-id';

/**
 * Spec 032 §3, `GET /api/v1/admin/support/tickets/{id}` — one ticket in full (AC-5).
 *
 * READING IS AUDITED (`support.ticket_read`). Reading someone's support ticket decides nothing, but
 * it is still something an admin did to a person's record, and it should be attributable — spec
 * 031's rule for its dispute reads, applied here for the same reason.
 *
 * The conflict check runs BEFORE the permission check, so an admin who raised this ticket is told
 * why they are refused rather than being told they lack a permission they in fact hold.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const ticketId = supportTicketIdFromUrl(request);

  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportReadPermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticket = await getTicketForAdmin(session.userId, ticketId, correlationId);
  return apiSuccess(ticket, correlationId);
});
