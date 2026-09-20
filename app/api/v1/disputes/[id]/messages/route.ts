import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import {
  listMessagesForAdmin,
  listMessagesForParticipant,
  parseDisputeMessageRequest,
  postAdminMessage,
  postParticipantMessage,
} from '@/lib/disputes';
import { disputeIdFromUrl, isParticipantOf } from '../../dispute-id';

/**
 * Spec 031 §3 "Dispute messages" (DECIDED-7), `POST /api/v1/disputes/{id}/messages`.
 *
 * ONE ROUTE, TWO AUTHORIZATION PATHS. A participant posts as themselves; an admin holding
 * `disputes/resolve` posts flagged `isAdmin`, so the parties can see an official message is
 * official. The participant check is decisive and comes first, so an admin who is also a party is
 * treated as the party they are.
 *
 * NO JUSTIFICATION PARAMETER, unlike spec 025's admin conversation read. A dispute message is
 * written TO BE READ by the deciding admin — that is its purpose, not an intrusion into a private
 * channel. Admin posts and admin reads are still audited.
 *
 * Contact details are FLAGGED, NEVER MASKED: a dispute only exists on a `protected` booking, long
 * past `confirmed`, so spec 025's own `applyContactPolicy` rule keeps the body verbatim and raises
 * a Trust & Safety signal. Redacting evidence would be wrong.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseDisputeMessageRequest(body);
  const idempotency = { key, fingerprint: idempotencyFingerprint(input) };

  const { message, replayed } = (await isParticipantOf(disputeId, session.userId))
    ? await postParticipantMessage(disputeId, session.userId, input, idempotency)
    : await postAdminMessage(disputeId, session.userId, input, idempotency, correlationId);

  return apiSuccess(message, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * `GET /api/v1/disputes/{id}/messages` — the thread, OLDEST FIRST, so it reads as a record of an
 * argument rather than as a chat feed.
 *
 * Both participants read the WHOLE thread, each other's messages included: a party who cannot see
 * what is being said about them cannot meaningfully respond or appeal. There are deliberately no
 * read receipts and no unread counts — those are spec 025's conversation features and are not
 * reproduced here.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const page = parsePageParams(new URL(request.url).searchParams);

  const { items, total } = (await isParticipantOf(disputeId, session.userId))
    ? await listMessagesForParticipant(disputeId, session.userId, page)
    : await listMessagesForAdmin(disputeId, session.userId, page, correlationId);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
