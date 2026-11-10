import { createHmac } from 'node:crypto';

/**
 * Single root secret for every auth-internal signing/encryption need (CSRF token derivation,
 * TOTP-secret-at-rest encryption). Purpose-scoped subkeys are derived via HMAC-SHA256 domain
 * separation (`deriveKey`) rather than reusing the root secret directly, so a key derived for
 * one purpose can't be replayed against another.
 */
function getRootSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET is not set (or is too short) — see .env.example. Must be at least 32 characters.');
  }
  return secret;
}

export function deriveKey(purpose: string): Buffer {
  return createHmac('sha256', getRootSecret()).update(purpose).digest();
}
