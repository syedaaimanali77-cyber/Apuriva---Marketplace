/**
 * Storage-capability CONTRACT for a `FileAsset`'s bytes — owned and implemented by spec 027
 * ("File Uploads & Media Storage"), not spec 008. Spec 008 (data export, lib/privacy/export.ts)
 * owns the export request's lifecycle, authorization, status, and its reference to a `FileAsset`
 * row; it must depend on this narrow interface to actually persist/retrieve the generated
 * artifact's bytes, never implement a storage backend of its own (no in-memory store, no
 * temporary column on `file_assets`, no local-disk adapter) — that was corrected once already
 * (an in-memory adapter) and must not recur in a different shape.
 *
 * Spec 027 is genuinely not implemented yet in this codebase (no object-storage adapter exists
 * anywhere), and this file does not implement it either — implementing it is spec 027's job, not
 * this correction's. `getFileAssetStorage()` throws until something registers a real
 * implementation, so the dependency is explicit and loud rather than silently faked: an export
 * that reaches the sweep without spec 027 wired up fails with a clear, logged reason and the
 * export is marked `failed` (lib/privacy/export.ts already handles storage errors this way) —
 * it does not fall back to a parallel storage mechanism to make itself appear to work.
 *
 * Tests that need a working export pipeline register a minimal, explicitly-labeled test double
 * via `registerFileAssetStorage` (see lib/privacy/test-support.ts `registerTestFileAssetStorage`)
 * — that's a test fixture standing in for an external dependency, the same way a payment-gateway
 * or email-provider call would be stubbed in a test, not a second production implementation.
 */
export interface FileAssetStorage {
  /** Persists `content` as the bytes backing `FileAsset` row `fileAssetId`. */
  store(fileAssetId: string, content: string): Promise<void>;
  /** Retrieves the bytes for `fileAssetId`, or `null` if none are stored (or the id is unknown). */
  retrieve(fileAssetId: string): Promise<string | null>;
}

let registered: FileAssetStorage | null = null;

/** Called by whatever wires up spec 027's real implementation (or a test's fixture) — never by
 * spec 008 itself with a spec-008-authored implementation. */
export function registerFileAssetStorage(storage: FileAssetStorage | null): void {
  registered = storage;
}

/**
 * Throws until spec 027's storage capability (or a test double standing in for it) has been
 * registered — see the module comment above for why this must not silently degrade to a
 * spec-008-owned fallback.
 */
export function getFileAssetStorage(): FileAssetStorage {
  if (!registered) {
    throw new Error(
      'No FileAsset storage implementation is registered. Spec 008 depends on spec 027\'s ' +
        'storage capability for export-artifact bytes and does not implement one itself — ' +
        'register a FileAssetStorage (registerFileAssetStorage) before this can succeed.',
    );
  }
  return registered;
}
