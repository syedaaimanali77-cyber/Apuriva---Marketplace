import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@/lib/auth/secret';

/**
 * Signed, time-limited download links for a ready data export (spec 008 §3/§6) — stateless
 * (HMAC over the export id + expiry, same domain-separated-subkey pattern as CSRF/TOTP, lib/auth/
 * secret.ts) rather than a stored token, so no extra table/column is needed to issue or verify
 * one. Deliberately not session-gated: a real signed URL stands on its own, like the presigned
 * URL spec 027 will eventually issue for `GET /api/v1/files/{id}`.
 */
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;

function sign(exportRequestId: string, expiresAtMs: number): string {
  return createHmac('sha256', deriveKey('data-export-download')).update(`${exportRequestId}.${expiresAtMs}`).digest('hex');
}

export function buildDownloadUrl(exportRequestId: string): { url: string; expiresAt: Date } {
  const expiresAtMs = Date.now() + DOWNLOAD_URL_TTL_MS;
  const sig = sign(exportRequestId, expiresAtMs);
  const url = `/api/v1/users/me/data-export/${exportRequestId}/download?exp=${expiresAtMs}&sig=${sig}`;
  return { url, expiresAt: new Date(expiresAtMs) };
}

export function verifyDownloadToken(exportRequestId: string, expiresAtMsRaw: string | null, sig: string | null): boolean {
  if (!expiresAtMsRaw || !sig) return false;
  const expiresAtMs = Number(expiresAtMsRaw);
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return false;

  const expected = Buffer.from(sign(exportRequestId, expiresAtMs), 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
