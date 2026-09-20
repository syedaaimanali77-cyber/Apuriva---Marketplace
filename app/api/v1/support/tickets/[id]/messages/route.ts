import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import {
  isRequesterOf,
  listMessages,
  parseSupportMessageRequest,
  postAdminMessage,
  postRequesterMessage,
  requireSupportReadPermission,
  requireSupportRespondPermission,
} from '@/lib/support';
import { supportTicketIdFromUrl } from '../../../support-id';

/**
 * Spec 032 §3 "Messages" (DECIDED-7), `POST /api/v1/support/tickets/{id}/messages`.
 *
 * ONE ROUTE, TWO AUTHORIZATION PATHS — spec 031's shape for its dispute thread. The REQUESTER check
 * is decisive and comes first, so an admin who is somehow the requester is treated as the requester
 * they are (and `assertNotOwnTicket` would refuse them the admin path anyway). Everyone else falls
 * through to the admin path, where `support/respond` answers `403` for a stranger without ever
 * revealing whether the ticket exists.
 *
 * A REQUESTER POST WHILE `awaiting_user` ALSO ENDS THE PAUSE. Their reply *is* the response the
 * admin asked for; making them press a second button to say so would only produce stale queues.
 *
 * Contact details are FLAGGED, NEVER MASKED — "my phone +44… isn't receiving codes" is the entire
 * content of a legitimate `account` ticket, and redacting it would make the ticket unanswerable.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticketId = supportTicketIdFromUrl(request, 1);
  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseSupportMessageRequest(body);
  const idempotency = { key, fingerprint: idempotencyFingerprint(input) };

  if (await isRequesterOf(ticketId, session.userId)) {
    const { message, replayed } = await postRequesterMessage(ticketId, session.userId, input, idempotency);
    return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
  }

  await requireSupportRespondPermission(session.userId);
  const { message, replayed } = await postAdminMessage(ticketId, session.userId, input, idempotency, correlationId);
  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * `GET /api/v1/support/tickets/{id}/messages` — the thread, OLDEST FIRST.
 *
 * Oldest-first because it is a record of an exchange, not a chat feed. There are deliberately no
 * read receipts and no unread counts: those are spec 025's conversation features and are not
 * reproduced here.
 *
 * Each message is projected to a RELATIVE author (`'you'` / `'support'`), so a requester never
 * learns which individual replied to them.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const ticketId = supportTicketIdFromUrl(request, 1);
  if (!(await isRequesterOf(ticketId, session.userId))) {
    await requireSupportReadPermission(session.userId);
  }

  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listMessages(ticketId, session.userId, page);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
