/**
 * Spec 027 §3 "Storage adapter seam" (AC-3, AC-11) — the capability contract every storage backend
 * implements. This repository has exactly one implementation, the local development adapter, and it
 * refuses to run under `NODE_ENV=production`: no object-storage or CDN vendor is chosen here, no
 * credential is invented, and nothing pretends bytes were stored (master §133.5–§133.7).
 *
 * A later spec supplies a real adapter behind this interface and nothing else changes.
 */
import type { ImageTransform } from '../optimization/types';

export interface UploadTarget {
  url: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StorageObjectHead {
  exists: boolean;
  sizeBytes: number;
  contentType: string | null;
}

export interface FileStorageAdapter {
  readonly name: string;
  /** True for an adapter that stores nothing durable. The factory refuses one in production. */
  readonly isSandbox?: boolean;

  /** Pre-signed (or local) destination for the client's bytes. */
  createUploadTarget(input: {
    storageKey: string;
    mimeType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<UploadTarget>;

  /** Existence + ACTUAL size/type, read at finalize — never trusted from the client (AC-1). */
  head(storageKey: string): Promise<StorageObjectHead>;

  /** First N bytes, for magic-byte sniffing at finalize. */
  readPrefix(storageKey: string, byteCount: number): Promise<Buffer>;

  readAll(storageKey: string): Promise<Buffer | null>;

  /** Server-side write — spec 008's export artifact and finalize-time variants. */
  write(storageKey: string, bytes: Buffer, contentType: string): Promise<void>;

  delete(storageKey: string): Promise<void>;

  /** Private objects only. The URL must expire; the adapter never returns a permanent one (AC-3). */
  createSignedUrl(input: {
    storageKey: string;
    fileAssetId: string;
    userId: string;
    ttlSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;

  /** Public objects only, and only for a `ready` asset. `null` when no CDN is configured (AC-2). */
  publicUrl(input: { storageKey: string; transform?: ImageTransform }): string | null;
}

/** Raised instead of falling back, so a misconfiguration fails loudly as `503` (AC-11). */
export class FileStorageUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileStorageUnavailable';
  }
}
