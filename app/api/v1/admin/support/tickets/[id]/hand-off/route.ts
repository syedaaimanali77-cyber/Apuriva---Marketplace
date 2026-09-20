import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { handOffTicket, parseHandOffRequest, requireSupportResolvePermission } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3 "Support ownership", `POST /api/v1/admin/support/tickets/{id}/hand-off` — the
 * one-way door out of support (DECIDED-1).
 *
 * IT DECIDES NOTHING. It files a spec 030 safety report through spec 030's OWN creation path,
 * records the id of a dispute a participant ALREADY OPENED through spec 031's own route, or records
 * that the matter belongs to Finance — and sets the legal hold so the ticket's attachments survive
 * spec 027's ordinary expiry. No sanction, no refund, no dispute resolution, no
 * `users.lifecycle_status`, no `refunds`/`payouts`/`payments` column.
 * `lib/support/no-consequential-action.test.ts` asserts that at source level.
 *
 * NOTHING COMES BACK either: the specialised record's outcome is never mirrored onto the ticket,
 * because two records of one decision can disagree and the participant already sees the real one
 * in the owning workflow.
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
  const ticket = await handOffTicket({
    adminUserId: session.userId,
    ticketId,
    request: parseHandOffRequest(body),
    correlationId,
  });
  return apiSuccess(ticket, correlationId);
});
