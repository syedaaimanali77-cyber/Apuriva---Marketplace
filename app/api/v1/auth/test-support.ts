import type { NextResponse } from 'next/server';
import { randomInt, randomUUID } from 'node:crypto';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** Reads the session/CSRF cookie values a route handler's response just set. */
export function sessionCookieFrom(res: NextResponse): string | undefined {
  return res.cookies.get(SESSION_COOKIE_NAME)?.value;
}

export function csrfCookieFrom(res: NextResponse): string | undefined {
  return res.cookies.get(CSRF_COOKIE_NAME)?.value;
}

/** Builds a follow-up authenticated request carrying the session cookie and CSRF header. */
export function authenticatedRequest(
  url: string,
  sessionId: string,
  csrfToken: string,
  init?: { method?: string; body?: unknown },
): Request {
  return new Request(url, {
    method: init?.method ?? 'POST',
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      [CSRF_HEADER_NAME]: csrfToken,
      'content-type': 'application/json',
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** A fresh, unique-per-call E.164-shaped phone number, so parallel tests never collide. */
export function uniquePhoneNumber(): string {
  const suffix = String(randomInt(1_000_000, 9_999_999));
  return `+1555${suffix}`;
}

export function uniqueEmail(): string {
  return `test-${randomUUID()}@example.test`;
}
