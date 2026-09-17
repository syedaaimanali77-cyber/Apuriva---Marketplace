/**
 * Spec 027 §3 — storage adapter selection, and AC-11's production guard. The same shape as spec
 * 021's `lib/payments/provider/index.ts` and spec 026's `lib/notifications/channels/index.ts` —
 * copied, not shared, because each seam owns its own vocabulary.
 *
 * Selection is `process.env.FILE_STORAGE_PROVIDER` (default `local`): an environment variable, not
 * a feature flag (spec 041). Two refusals, both hard:
 *   - an unknown value throws — no silent fallback to the local adapter because a variable was
 *     mistyped, which would quietly store production bytes on an ephemeral disk;
 *   - a sandbox adapter under `NODE_ENV=production` throws.
 * Either way the caller answers `503 FILE_STORAGE_UNAVAILABLE` and nothing is marked `ready`.
 */
import { createLocalFileStorageAdapter } from './local';
import type { FileStorageAdapter } from './types';
import { FileStorageUnavailable } from './types';

export type {
  FileStorageAdapter,
  StorageObjectHead,
  UploadTarget,
} from './types';
export { FileStorageUnavailable } from './types';
export { checksumOf, createLocalFileStorageAdapter, LOCAL_STORAGE_ADAPTER_NAME } from './local';
export { buildContentUrl, buildUploadUrl, verifyContentSignature, verifyUploadSignature } from './signing';

export const FILE_STORAGE_PROVIDER_ENV_VAR = 'FILE_STORAGE_PROVIDER';
const DEFAULT_PROVIDER = 'local';

/** The storage providers this repository actually has. A real vendor registers its name here. */
const PROVIDERS: Record<string, () => FileStorageAdapter> = {
  local: createLocalFileStorageAdapter,
};

/** Read fresh on every call: a cached adapter would let whichever call warmed it bypass the guard. */
export function resolveFileStorageAdapter(): FileStorageAdapter {
  const configured = (process.env.FILE_STORAGE_PROVIDER ?? '').trim() || DEFAULT_PROVIDER;
  const factory = PROVIDERS[configured];
  if (!factory) {
    throw new FileStorageUnavailable(`${FILE_STORAGE_PROVIDER_ENV_VAR}="${configured}" is not a known file storage provider.`);
  }
  const adapter = factory();
  if (process.env.NODE_ENV === 'production' && adapter.isSandbox) {
    throw new FileStorageUnavailable(
      `The "${configured}" file storage adapter is a sandbox and must never run in production. Configure a real object-storage adapter.`,
    );
  }
  return adapter;
}
