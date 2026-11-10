/**
 * Spec 027 §3 "Signed URLs and why a stale link cannot bypass authorization" (AC-3, AC-6).
 *
 * The exact stateless pattern spec 008 already ships (`lib/privacy/download-token.ts`): an HMAC
 * over the tuple, with a domain-separated subkey from `deriveKey`. No token table, nothing to
 * revoke, nothing to leak from storage.
 *
 * The signature covers `(fileAssetId, userId, expiresAt)` — so it is worthless to anyone but the
 * user it was issued to, and worthless to them once it expires. It is deliberately NOT an
 * authorization: `GET /files/{id}/content` re-runs the context policy's `canRead` for the bound
 * user on EVERY fetch, which is what makes a link stop working the moment the access behind it is
 * revoked. A signature says "this link was issued to you", never "you may read this".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '@/lib/auth/secret';

const SIGNING_PURPOSE = 'file-download';

function sign(fileAssetId: string, userId: string, expiresAtMs: number): string {
  return createHmac('sha256', deriveKey(SIGNING_PURPOSE))
    .update(`${fileAssetId}.${userId}.${expiresAtMs}`)
    .digest('hex');
}

export interface ContentUrlParts {
  path: string;
  expiresAt: Date;
}

/** The `GET /api/v1/files/{id}/content` URL a private asset is served through. */
export function buildContentUrl(fileAssetId: string, userId: string, ttlSeconds: number): ContentUrlParts {
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const signature = sign(fileAssetId, userId, expiresAtMs);
  const query = new URLSearchParams({ uid: userId, exp: String(expiresAtMs), sig: signature });
  return { path: `/api/v1/files/${fileAssetId}/content?${query.toString()}`, expiresAt: new Date(expiresAtMs) };
}

export interface VerifiedSignature {
  userId: string;
}

/**
 * Returns the bound user id, or `null` for a missing, malformed, expired or forged signature.
 * Never throws and never reveals which of those it was — the caller answers `404` either way.
 */
export function verifyContentSignature(fileAssetId: string, params: URLSearchParams): VerifiedSignature | null {
  const userId = params.get('uid');
  const expiresAtRaw = params.get('exp');
  const signature = params.get('sig');
  if (!userId || !expiresAtRaw || !signature) return null;

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null;

  const expected = Buffer.from(sign(fileAssetId, userId, expiresAtMs), 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'hex');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { userId };
}

/**
 * The upload target the LOCAL adapter hands the client: the same content route, `PUT`, signed the
 * same way but with a distinct purpose so an upload credential can never be replayed as a download
 * one. A real vendor's adapter returns its own pre-signed URL here instead.
 */
const UPLOAD_PURPOSE = 'file-upload';

function signUpload(storageKey: string, expiresAtMs: number): string {
  return createHmac('sha256', deriveKey(UPLOAD_PURPOSE)).update(`${storageKey}.${expiresAtMs}`).digest('hex');
}

export function buildUploadUrl(fileAssetId: string, storageKey: string, ttlSeconds: number): ContentUrlParts {
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const query = new URLSearchParams({ key: storageKey, exp: String(expiresAtMs), sig: signUpload(storageKey, expiresAtMs) });
  return { path: `/api/v1/files/${fileAssetId}/content?${query.toString()}`, expiresAt: new Date(expiresAtMs) };
}

export function verifyUploadSignature(params: URLSearchParams): { storageKey: string } | null {
  const storageKey = params.get('key');
  const expiresAtRaw = params.get('exp');
  const signature = params.get('sig');
  if (!storageKey || !expiresAtRaw || !signature) return null;

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null;

  const expected = Buffer.from(signUpload(storageKey, expiresAtMs), 'hex');
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'hex');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { storageKey };
}
