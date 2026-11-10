import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { getSessionIdFromRequest, clearSessionCookies } from '@/lib/auth/cookies';
import { requireCsrf } from '@/lib/auth/require-session';
import { revokeSession, validateAndRefreshSession } from '@/lib/auth/session';
import { recordSecurityEvent } from '@/lib/auth/security-event';

/**
 * Spec 005 §3, `POST /api/v1/auth/logout` — invalidates the current session. Idempotent: no
 * session cookie (or an already-invalid one) still returns `204`, since the desired end state
 * ("no active session") already holds.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const sessionId = getSessionIdFromRequest(request);

  if (sessionId) {
    requireCsrf(request, sessionId);
    const result = await validateAndRefreshSession(sessionId);
    await revokeSession(sessionId);
    if (result.valid) {
      await recordSecurityEvent({ userId: result.session.userId, eventType: 'auth.logout', severity: 'info' });
    }
  }

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  clearSessionCookies(res);
  return res;
});
