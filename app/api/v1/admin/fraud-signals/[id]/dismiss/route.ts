import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { parseTriageRequest, triageFraudSignal } from '@/lib/moderation';
import { enforceModerationRateLimit, pathId } from '../../../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 F2, `POST /api/v1/admin/fraud-signals/{id}/dismiss` — behind `fraud_signals/triage`.
 * Conditional on `expectedStatus`, so two admins cannot overwrite each other (`409` with the truth).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  requireIdempotencyKey(request);
  const input = parseTriageRequest(await request.json().catch(() => ({})));
  const signal = await triageFraudSignal({
    adminUserId: session.userId,
    signalId: pathId(request, 1),
    to: 'dismissed',
    expectedStatus: input.expectedStatus,
    reason: input.reason,
    correlationId,
  });
  return apiSuccess(signal, correlationId);
});
