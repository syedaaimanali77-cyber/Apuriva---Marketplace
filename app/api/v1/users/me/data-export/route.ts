import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { requireStepUp } from '@/lib/auth/step-up';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { requestExport } from '@/lib/privacy/export';

const STEP_UP_ACTION = 'request_data_export';

/**
 * Spec 008 AC-3, `POST /api/v1/users/me/data-export` — starts (or, while one is already
 * pending/processing, returns the existing) export request. Actual generation happens in the
 * scheduled sweep (app/api/v1/cron/data-export-sweep), never inline in this request.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireStepUp(request, session, STEP_UP_ACTION);

  const { exportRequestId } = await requestExport(session.userId);
  await recordSecurityEvent({
    userId: session.userId,
    eventType: 'privacy.data_export_requested',
    severity: 'info',
    metadata: { exportRequestId },
  });

  return apiSuccess({ exportRequestId }, correlationId, { status: 202 });
});
