import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { requireStepUp } from '@/lib/auth/step-up';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { getDeletionStatus, requestDeletion } from '@/lib/privacy/deletion';

const STEP_UP_ACTION = 'request_account_deletion';

/** Read side of the same resource — lets the UI show "Deletion Pending until <date>" and the
 * cancel option again after a reload. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const status = await getDeletionStatus(session.userId);
  return apiSuccess(status, correlationId);
});

/**
 * Spec 008 AC-4, `POST /api/v1/users/me/deletion` — deterministic: an active booking rejects the
 * request outright (`422 ACTIVE_BOOKING_BLOCKS_DELETION`, no pending state entered); a repeat
 * request while already pending is `409 DELETION_ALREADY_PENDING`. Otherwise starts the grace
 * period (lib/privacy/deletion.ts owns the 14-day default).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireStepUp(request, session, STEP_UP_ACTION);

  const { gracePeriodEndsAt } = await requestDeletion(session.userId);
  await recordSecurityEvent({
    userId: session.userId,
    eventType: 'privacy.deletion_requested',
    severity: 'warning',
    metadata: { gracePeriodEndsAt: gracePeriodEndsAt.toISOString() },
  });

  return apiSuccess({ gracePeriodEndsAt: gracePeriodEndsAt.toISOString() }, correlationId, { status: 202 });
});
