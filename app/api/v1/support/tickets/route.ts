import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { createSupportTicket, listTicketsForUser, parseCreateTicketRequest } from '@/lib/support';

/**
 * Spec 032 §3, `POST /api/v1/support/tickets` — raise a ticket (AC-2, AC-4).
 *
 * THERE IS NO `priority` FIELD, and that is the enforcement rather than a convention:
 * `parseCreateTicketRequest` rejects the property outright with a message explaining that the
 * platform sets priority from the category. A client cannot self-escalate, and one that tries is
 * told so rather than silently ignored.
 *
 * NO ACTIVE MODE IS REQUIRED. A support ticket is filed by a person, not by a role — a provider may
 * well need help with something they did as a customer. The session's mode is RECORDED in
 * `requester_mode` so the admin knows which hat they were wearing; it gates nothing.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseCreateTicketRequest(body);

  const { ticket, replayed } = await createSupportTicket(session.userId, session.activeMode, input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(ticket, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * `GET /api/v1/support/tickets` — the caller's own tickets, newest first.
 *
 * Scoped by `requester_user_id` in the query's own `WHERE`, not filtered afterwards, so there is no
 * code path that could widen it. The summary shape carries no description, no priority history and
 * no admin identity — the detail route applies the full participant projection.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listTicketsForUser(session.userId, page);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
