import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseLegalHoldRequest, setLegalHold } from '@/lib/disputes';
import { disputeIdFromUrl } from '../../../../disputes/dispute-id';

/**
 * Spec 031 §3, `POST /api/v1/admin/disputes/{id}/legal-hold` — DECIDED-6.
 *
 * Sets or clears `disputes.legal_hold`. While true, spec 027's purge sweep and spec 008's
 * account-deletion anonymization both skip the dispute's evidence, through the EXISTING
 * `file_assets.legal_hold` flag that `lib/files/deletion.ts` already honours ("`legal_hold` assets
 * are the exception: they are evidence a later spec must keep"). No second hold mechanism, no
 * second sweep and no new column.
 *
 * ALWAYS EXPLICIT, ALWAYS AUDITED. There is deliberately no rule that sets a hold automatically
 * above some amount (§8 "Operational inputs"): a legal hold is a legal judgement, and a threshold
 * invented here would be the platform quietly making one.
 *
 * A reason is mandatory (master §68), and both directions are audited separately —
 * `disputes.legal_hold_set` and `disputes.legal_hold_cleared` — because releasing a hold is at
 * least as consequential as placing one.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireIdempotencyKey(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  const input = parseLegalHoldRequest(body);

  const dispute = await setLegalHold(disputeIdFromUrl(request, 1), session.userId, input, correlationId);
  return apiSuccess(dispute, correlationId);
});
