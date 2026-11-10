/**
 * Spec 027 §9 "Environment" — the eleven operational knobs, kept in parity with `.env.example` by
 * `npm run check:env`. Server-side configuration, not feature flags (spec 041 owns those).
 *
 * Read fresh on every call, the same rule spec 021/026's adapters follow: a cached value would let
 * whichever call warmed it bypass a later change — including AC-11's production guard.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileKind } from '@/lib/types/files';

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** §3 "Limits" — explicit product defaults, every one environment-configurable (§8 #8). */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export function maxBytesFor(kind: FileKind): number {
  switch (kind) {
    case 'image':
      return positiveInt(process.env.FILE_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);
    case 'document':
      return positiveInt(process.env.FILE_MAX_DOCUMENT_BYTES, DEFAULT_MAX_DOCUMENT_BYTES);
    case 'video':
      return positiveInt(process.env.FILE_MAX_VIDEO_BYTES, DEFAULT_MAX_VIDEO_BYTES);
  }
}

/** AC-3: how long an issued signed URL stays valid (default 300s). */
export function signedUrlTtlSeconds(): number {
  return positiveInt(process.env.FILE_SIGNED_URL_TTL_SECONDS, 300);
}

/** How long the client has to PUT the bytes before the reservation is swept (default 900s). */
export function uploadUrlTtlSeconds(): number {
  return positiveInt(process.env.FILE_UPLOAD_URL_TTL_SECONDS, 900);
}

/** AC-4: scan attempts before a still-unresolved asset stops being auto-claimed (default 5). */
export function scanMaxAttempts(): number {
  return positiveInt(process.env.FILE_SCAN_MAX_ATTEMPTS, 5);
}

/** AC-9: days a soft-deleted asset's bytes are retained before the sweep purges them (default 7). */
export function purgeGraceDays(): number {
  return positiveInt(process.env.FILE_PURGE_GRACE_DAYS, 7);
}

/** Where the local development adapter keeps bytes — the OS temp dir, never the repository. */
export function localStorageDir(): string {
  const configured = (process.env.FILE_STORAGE_LOCAL_DIR ?? '').trim();
  return configured.length > 0 ? configured : join(tmpdir(), 'apuriva-file-storage');
}

/** Unset means no public URL exists at all — `publicUrl()` returns `null` (AC-2/AC-3). */
export function publicCdnBaseUrl(): string | null {
  const configured = (process.env.FILE_PUBLIC_CDN_BASE_URL ?? '').trim();
  return configured.length > 0 ? configured.replace(/\/+$/, '') : null;
}

/** Rows one sweep pass claims per phase; the next run is the continuation. */
export const SWEEP_BATCH_LIMIT = 200;
