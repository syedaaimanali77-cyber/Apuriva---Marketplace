import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { validationError } from '@/lib/api/errors';
import { requireSession } from '@/lib/auth/require-session';
import { isUuid } from '@/lib/offers/validation';
import { FRAUD_SIGNAL_STATUSES } from '@/lib/db/schema';
import { listFraudSignals } from '@/lib/moderation';
import type { FraudSignalStatus } from '@/lib/types/moderation';
import { enforceModerationRateLimit } from '../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 F1, `GET /api/v1/admin/fraud-signals` — behind `fraud_signals/read`. A review queue
 * only: nothing here, or anywhere in the signal code, enforces anything (AC-3). Escalated first,
 * then pending, FIFO among equals.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceModerationRateLimit(session.userId);
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  const targetUserId = params.get('targetUserId');
  if (status && !(FRAUD_SIGNAL_STATUSES as readonly string[]).includes(status)) {
    throw validationError([{ field: 'status', message: 'is not a fraud signal status' }]);
  }
  if (targetUserId && !isUuid(targetUserId)) throw validationError([{ field: 'targetUserId', message: 'must be a UUID' }]);
  const page = parsePageParams(params);
  const { rows, total } = await listFraudSignals(
    session.userId,
    { status: (status as FraudSignalStatus) ?? undefined, targetUserId: targetUserId ?? undefined },
    page,
  );
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
