import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { reopenTicketAsAdmin, requireSupportResolvePermission } from '@/lib/support';
import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '@/lib/support/limits';
import { normalizeSupportText } from '@/lib/support/validation';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3, `POST /api/v1/admin/support/tickets/{id}/reopen`.
 *
 * Inside the same window as the requester's, but it DOES NOT CONSUME their one — which is why
 * `support_tickets_reopen_count_ck` allows up to 2. An admin reopening because they realise they
 * resolved something prematurely must not thereby spend the user's only recourse.
 *
 * A reason is required: unlike the requester's reopen, this is an admin overriding a recorded
 * decision, and master §70 wants a reason on those.
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

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === 'string' ? normalizeSupportText(body.reason) : null;
  if (reason === null || reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw validationError([
      { field: 'reason', message: `must be ${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters` },
    ]);
  }

  const ticket = await reopenTicketAsAdmin({
    adminUserId: session.userId,
    ticketId,
    reason,
    expectedStatus: 'resolved',
    correlationId,
  });
  return apiSuccess(ticket, correlationId);
});
