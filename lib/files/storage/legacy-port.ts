/**
 * Spec 027 AC-10 — spec 008's `FileAssetStorage` port, finally IMPLEMENTED.
 *
 * `lib/privacy/file-asset-storage.ts` has always declared a narrow `store(id, content)` /
 * `retrieve(id)` contract and thrown until something registered an implementation. This is that
 * something. Read what it does NOT do, because that is the point:
 *
 *   - it does not modify one line of spec 008;
 *   - it does not replace or duplicate that port with a second storage seam;
 *   - it does not require spec 008's bare `file_assets` insert (owner id only) to change — such a
 *     row reads as a `private`, `pending`, context-less document under this spec's new columns,
 *     which is exactly what it is, and every added column in migration 0023 is nullable or
 *     defaulted precisely so that insert keeps working untouched.
 *
 * The export artifact's bytes go through the SAME `FileStorageAdapter` as every uploaded file, so
 * there is one storage backend in this repository, not two. Spec 008's `users.data_export_status`
 * remains the authority on whether an export is available, and this spec's routes refuse
 * `data_export` assets outright — so implementing the port opens no second path to an export.
 */
import { registerFileAssetStorage, type FileAssetStorage } from '@/lib/privacy/file-asset-storage';
import { resolveFileStorageAdapter } from './index';

/** Export artifacts live under their own prefix, so they are never confused with an upload key. */
export function exportStorageKey(fileAssetId: string): string {
  return `exports/${fileAssetId}`;
}

const EXPORT_CONTENT_TYPE = 'application/json';

export function createFileAssetStoragePort(): FileAssetStorage {
  return {
    async store(fileAssetId: string, content: string): Promise<void> {
      // Resolved per call, so spec 008 is subject to the same production guard as everything else:
      // an export can never be "stored" by a sandbox adapter in production either (AC-11).
      await resolveFileStorageAdapter().write(exportStorageKey(fileAssetId), Buffer.from(content, 'utf8'), EXPORT_CONTENT_TYPE);
    },

    async retrieve(fileAssetId: string): Promise<string | null> {
      const bytes = await resolveFileStorageAdapter().readAll(exportStorageKey(fileAssetId));
      return bytes === null ? null : bytes.toString('utf8');
    },
  };
}

/** Called from `instrumentation.ts`, the composition root — never from inside spec 008. */
export function registerFileAssetStoragePort(): void {
  registerFileAssetStorage(createFileAssetStoragePort());
}
