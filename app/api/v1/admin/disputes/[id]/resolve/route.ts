import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseResolveRequest, resolveDispute } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/admin/disputes/{id}/resolve` — AC-3, AC-5.
 *
 * THIS ROUTE MOVES NO MONEY. A `refund_customer` or `partial_refund_customer` decision records a
 * PROPOSED amount and nothing more: no `refunds` row is created, no payment provider is called, no
 * payout column is written. Migration `0018` seeds `refunds/override` to `finance_admin` and
 * `super_admin` only, so the Trust & Safety admin resolving here is structurally incapable of
 * issuing the refund they just proposed — which is the separation of duties, not an obstacle.
 *
 * The chain from here is three-eyed and entirely spec 022's and spec 009's:
 *   Finance calls `POST /api/v1/admin/refunds` (tier `high`) → a SECOND admin approves →
 *   spec 022 creates the refund and calls the provider. `link-refund` records the `adminActionId`.
 *
 * NO `authorizeAndInitiate()` CALL HERE. `disputes/resolve` is tier `medium` — master §70's
 * "authorized admin + reason/audit" — because the resolution itself moves nothing. The money it may
 * propose is already four-eyed at spec 022. Gating the same decision twice would buy nothing.
 *
 * NOTHING IS RELEASED. The dispute becomes `resolved`, not `closed`, so the gate keeps answering
 * `open: true` and the payment stays `disputed` for the whole appeal window (AC-4).
 *
 * A reason (`reasoning`) is MANDATORY and is shown to BOTH parties — master §2.3 requires the
 * reasoning, not just the outcome.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseResolveRequest(body);

  const resolution = await resolveDispute(
    disputeIdFromUrl(request, 1),
    session.userId,
    input,
    { key, fingerprint: idempotencyFingerprint(input) },
    correlationId,
  );

  return apiSuccess(resolution, correlationId);
});
