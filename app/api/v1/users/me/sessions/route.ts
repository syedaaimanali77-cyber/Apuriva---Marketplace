import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { requireStepUp } from '@/lib/auth/step-up';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { listActiveSessions, revokeAllOtherSessions, toSessionSummaryDto } from '@/lib/privacy/sessions';

const STEP_UP_ACTION = 'logout_all_other_devices';

/** Spec 008 AC-1, `GET /api/v1/users/me/sessions` — only the caller's own active sessions. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const rows = await listActiveSessions(session.userId);
  const dto = rows.map((row) => toSessionSummaryDto(row, session.id));
  return apiSuccess(dto, correlationId);
});

/**
 * Spec 008 AC-2/AC-5, `DELETE /api/v1/users/me/sessions` — "log out all devices": revokes every
 * session belonging to the caller EXCEPT the current one, which this action never touches. Fresh
 * step-up is required regardless of normal session freshness.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireStepUp(request, session, STEP_UP_ACTION);

  await revokeAllOtherSessions(session.userId, session.id);
  await recordSecurityEvent({ userId: session.userId, eventType: 'privacy.sessions_revoked_all_other', severity: 'info' });

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
