import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import {
  addInternalNote,
  listNotes,
  parseSupportNoteRequest,
  requireSupportReadPermission,
  requireSupportRespondPermission,
} from '@/lib/support';
import { assertNotOwnTicket, supportTicketIdFromUrl } from '../../../../../support/support-id';

/**
 * Spec 032 §3 "Messages", `POST /api/v1/admin/support/tickets/{id}/notes` — INTERNAL, never
 * customer-visible.
 *
 * Notes live in their own table (`support_notes`), never as rows in `support_messages`. That
 * separation is the whole privacy design: no projection bug in the thread query can leak an
 * internal note to a requester, because the thread query does not read this table and no
 * participant code path in `lib/support/` reads it either. This route is the only writer, and it is
 * under `/admin/` behind `support/respond`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const ticketId = supportTicketIdFromUrl(request, 1);
  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportRespondPermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseSupportNoteRequest(body);

  const { note, replayed } = await addInternalNote({
    adminUserId: session.userId,
    ticketId,
    body: input.body,
    idempotency: { key, fingerprint: idempotencyFingerprint(input) },
    correlationId,
  });

  return apiSuccess(note, correlationId, { status: replayed ? 200 : 201 });
});

/** `GET` — the notes, oldest first. Admin-only by route placement AND by permission. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const ticketId = supportTicketIdFromUrl(request, 1);
  await assertNotOwnTicket(ticketId, session.userId);
  await requireSupportReadPermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { items, total } = await listNotes(ticketId, page);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
