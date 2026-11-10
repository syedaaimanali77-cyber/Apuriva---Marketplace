/**
 * Spec 027 §3 "Storage adapter seam" — the LOCAL development/test adapter (master §133.7).
 *
 * STATED PLAINLY: this is local disk under `FILE_STORAGE_LOCAL_DIR` (by default a directory in the
 * OS temp dir, so nothing ever lands in the repository and `.gitignore` is untouched). It is not
 * object storage, there is no durability guarantee, no replication and no CDN.
 * `resolveFileStorageAdapter()` refuses it under `NODE_ENV=production`, so a production deployment
 * without a real adapter fails loudly instead of pretending a file was stored (AC-11).
 *
 * `createUploadTarget` returns this application's own `PUT /api/v1/files/{id}/content` route rather
 * than inventing a vendor's pre-signed URL. `publicUrl` returns `null` unless
 * `FILE_PUBLIC_CDN_BASE_URL` is configured — an unconfigured CDN has no public URL, and claiming one
 * would be the exact fake success this seam exists to prevent.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { localStorageDir, publicCdnBaseUrl } from '../config';
import type { ImageTransform } from '../optimization/types';
import { buildContentUrl, buildUploadUrl } from './signing';
import type { FileStorageAdapter, StorageObjectHead, UploadTarget } from './types';
import { FileStorageUnavailable } from './types';

export const LOCAL_STORAGE_ADAPTER_NAME = 'local';

/**
 * A storage key is server-derived (`<ownerId>/<assetId>`), never client-supplied — but this adapter
 * still refuses anything that could escape its root, because "the caller is trusted" is exactly the
 * assumption a path-traversal bug is made of.
 */
function resolveObjectPath(storageKey: string): string {
  const root = resolve(localStorageDir());
  const target = resolve(join(root, storageKey));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FileStorageUnavailable('Refusing a storage key that resolves outside the local storage root.');
  }
  return target;
}

export function createLocalFileStorageAdapter(): FileStorageAdapter {
  return {
    name: LOCAL_STORAGE_ADAPTER_NAME,
    isSandbox: true,

    async createUploadTarget(input): Promise<UploadTarget> {
      // `storageKey` is `<ownerId>/<fileAssetId>`; the route the client PUTs to is keyed by the asset.
      const fileAssetId = input.storageKey.split('/').pop() ?? input.storageKey;
      const { path, expiresAt } = buildUploadUrl(fileAssetId, input.storageKey, input.ttlSeconds);
      return {
        url: path,
        method: 'PUT',
        headers: { 'content-type': input.mimeType },
        expiresAt,
      };
    },

    async head(storageKey): Promise<StorageObjectHead> {
      try {
        const stats = await stat(resolveObjectPath(storageKey));
        return { exists: true, sizeBytes: stats.size, contentType: null };
      } catch {
        return { exists: false, sizeBytes: 0, contentType: null };
      }
    },

    async readPrefix(storageKey, byteCount): Promise<Buffer> {
      let handle;
      try {
        handle = await open(resolveObjectPath(storageKey), 'r');
      } catch {
        return Buffer.alloc(0);
      }
      try {
        const buffer = Buffer.alloc(byteCount);
        const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },

    async readAll(storageKey): Promise<Buffer | null> {
      try {
        return await readFile(resolveObjectPath(storageKey));
      } catch {
        return null;
      }
    },

    async write(storageKey, bytes): Promise<void> {
      const path = resolveObjectPath(storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },

    async delete(storageKey): Promise<void> {
      // Idempotent: purging bytes that are already gone is a success, not an error.
      await rm(resolveObjectPath(storageKey), { force: true });
    },

    async createSignedUrl(input) {
      const { path, expiresAt } = buildContentUrl(input.fileAssetId, input.userId, input.ttlSeconds);
      return { url: path, expiresAt };
    },

    publicUrl(input): string | null {
      const base = publicCdnBaseUrl();
      if (!base) return null;
      const query = transformQuery(input.transform);
      return `${base}/${input.storageKey}${query}`;
    },
  };
}

/**
 * AC-2: the delivery transform the `ImageOptimizer` port defines, expressed on the URL. This
 * repository has no image library and resizes nothing itself (§8 #10) — the transform is carried
 * honestly as a delivery instruction for whatever CDN is eventually configured, not claimed as a
 * resize that happened.
 */
function transformQuery(transform: ImageTransform | undefined): string {
  if (!transform) return '';
  const params = new URLSearchParams();
  if (transform.width !== undefined) params.set('w', String(transform.width));
  if (transform.quality !== undefined) params.set('q', String(transform.quality));
  if (transform.format !== undefined) params.set('fm', transform.format);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** Stored alongside the row so a later integrity check has something to compare against. */
export function checksumOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
