import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { createBlock, listBlocks, parseCreateBlockRequest } from '@/lib/safety';

/**
 * Spec 030 §3, `POST /api/v1/blocks` — S1, AC-1.
 *
 * ADDRESSED BY `targetUserId` IN THE BODY, not by a `/users/{id}` path. Verified: this repository
 * has no `users/{id}` route convention at all — `app/api/v1/users/` contains only `me/*`. A block
 * is also a first-class resource the caller owns, which is what makes S2's list and S3's undo
 * natural. The client legitimately holds the target's user id because spec 025's
 * `ConversationParticipantDto.userId` exposes it.
 *
 * A duplicate replays `200` rather than erroring: the caller owns that row, so telling them it
 * already exists enumerates nothing. `user_blocks_pair_uq` is what makes that safe under
 * concurrency.
 *
 * Either active mode: being harassed is not role-scoped, and forcing a mode switch before someone
 * can protect themselves would be a barrier at exactly the wrong moment.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseCreateBlockRequest(body);
  void idempotencyFingerprint(input);

  const { block, replayed } = await createBlock(session.userId, input.targetUserId);
  return apiSuccess(block, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * `GET /api/v1/blocks` — S2. The caller's OWN blocks only.
 *
 * There is deliberately no "who blocked me" route anywhere in this spec: telling someone they were
 * blocked hands a harasser a signal to act on, and master §53 asks for protection, not notification.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { rows, total } = await listBlocks(session.userId, page);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
