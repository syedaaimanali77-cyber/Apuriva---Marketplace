import type { NextResponse } from 'next/server';
import { CSRF_COOKIE_NAME, deriveCsrfToken } from './csrf';
import { SESSION_COOKIE_NAME } from './session';

/** Parses the raw `Cookie` request header — avoids depending on `NextRequest`-specific typing. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function getSessionIdFromRequest(request: Request): string | undefined {
  return readCookie(request, SESSION_COOKIE_NAME);
}

/**
 * Sets both the httpOnly session cookie and its paired, JS-readable CSRF cookie (spec 005 §3).
 * `expiresAt` matches the session row's `expires_at` — the cookie never outlives the session.
 */
export function setSessionCookies(res: NextResponse, sessionId: string, expiresAt: Date): void {
  res.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  res.cookies.set(CSRF_COOKIE_NAME, deriveCsrfToken(sessionId), {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookies(res: NextResponse): void {
  res.cookies.delete(SESSION_COOKIE_NAME);
  res.cookies.delete(CSRF_COOKIE_NAME);
}
