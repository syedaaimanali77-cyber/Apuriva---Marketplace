import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './secret';

/**
 * Double-submit CSRF token — spec 005 §3 "CSRF protection". Deterministically derived from the
 * session ID via HMAC (no separate storage needed): the server can always recompute the expected
 * value from the session cookie it already validated, and compare it against what the client
 * echoed back in the `X-CSRF-Token` header.
 */
export const CSRF_COOKIE_NAME = 'apuriva_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function deriveCsrfToken(sessionId: string): string {
  return createHmac('sha256', deriveKey('csrf-token')).update(sessionId).digest('hex');
}

export function verifyCsrfToken(sessionId: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(deriveCsrfToken(sessionId), 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
