import { ApiRouteError } from '@/lib/api/errors';
import { CSRF_HEADER_NAME, verifyCsrfToken } from './csrf';
import { getSessionIdFromRequest } from './cookies';
import { mfaRequiredError, csrfTokenInvalidError } from './errors';
import { type SessionRow, validateAndRefreshSession } from './session';

function unauthenticated(message = 'No valid session.'): ApiRouteError {
  return new ApiRouteError('UNAUTHENTICATED', message);
}

/**
 * Route guard for `session` / `session (partial)` auth (spec 005 §3 endpoint table). Silently
 * refreshes a valid full session (§8 risk #3) as a side effect. `allowPartial: true` is only for
 * `/api/v1/auth/mfa/verify`, the one endpoint an MFA-pending session is allowed to call.
 */
export async function requireSession(request: Request, options?: { allowPartial?: boolean }): Promise<SessionRow> {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) throw unauthenticated();

  const result = await validateAndRefreshSession(sessionId);
  if (!result.valid) throw unauthenticated();

  if (!result.session.mfaSatisfied && !options?.allowPartial) throw mfaRequiredError();

  return result.session;
}

/**
 * Spec 012 §3: the first "session or guest" route in this repo — every other route so far either
 * calls `requireSession` above or skips auth entirely for a fully public route. Returns the
 * session when a valid one is present, `null` for a guest, and never throws — a route using this
 * must not assume a caller is signed in the way `requireSession` callers can.
 */
export async function getOptionalSession(request: Request): Promise<SessionRow | null> {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const result = await validateAndRefreshSession(sessionId);
  return result.valid ? result.session : null;
}

/**
 * Double-submit CSRF check (spec 005 §3) for a state-changing request already carrying a session
 * cookie. Requires the `X-CSRF-Token` header specifically — a cross-site request can't set a
 * custom header, which is the whole point of the double-submit pattern; a cookie-only fallback
 * would defeat it. Not applied to the anonymous pre-session endpoints (otp/request, otp/verify,
 * register, login, oauth/*) — there's no session cookie yet for an attacker to ride.
 */
export function requireCsrf(request: Request, sessionId: string): void {
  const headerValue = request.headers.get(CSRF_HEADER_NAME);
  if (!verifyCsrfToken(sessionId, headerValue)) throw csrfTokenInvalidError();
}
