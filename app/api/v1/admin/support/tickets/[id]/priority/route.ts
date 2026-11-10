import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parsePriorityChangeRequest, requireSupportTriagePermission, setTicketPriority } from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3 "Categories and priority", `POST /api/v1/admin/support/tickets/{id}/priority` — AC-4.
 *
 * THE ONLY WAY A PRIORITY EVER MOVES after creation, and it is human-set: an authorized admin
 * chooses a value and states a reason, and both the old and the new value go to the audit trail.
 * Nothing here reads the ticket's content — no heuristic, no text analysis, no AI.
 *
 * It RECOMPUTES the SLA deadline from `created_at` plus the accumulated pause, which is why
 * `support/triage` is `medium` rather than `low`: this changes a deadline someone is measured by.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const ticketId = supportTicketIdFromUrl(request, 1);
  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportTriagePermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const ticket = await setTicketPriority({
    adminUserId: session.userId,
    ticketId,
    request: parsePriorityChangeRequest(body),
    correlationId,
  });
  return apiSuccess(ticket, correlationId);
});
