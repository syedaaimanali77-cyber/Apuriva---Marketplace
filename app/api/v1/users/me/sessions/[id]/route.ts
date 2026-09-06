import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { revokeOwnSession } from '@/lib/privacy/sessions';

/** Extracted from the URL directly (not Next's route `context`) since `withApiRoute` (spec 004)
 * only forwards `(request, correlationId)` — see lib/api/handler.ts. */
function sessionIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/**
 * Spec 008 AC-1, `DELETE /api/v1/users/me/sessions/{id}` — revokes one device, but only if `id`
 * belongs to the caller. Another user's (or a nonexistent) session id throws the identical
 * `404 NOT_FOUND` either way (lib/privacy/not-found.ts) — never revealing which case it was.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const targetSessionId = sessionIdFromUrl(request);
  await revokeOwnSession(session.userId, targetSessionId);
  await recordSecurityEvent({
    userId: session.userId,
    eventType: 'privacy.session_revoked',
    severity: 'info',
    metadata: { sessionId: targetSessionId },
  });

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
