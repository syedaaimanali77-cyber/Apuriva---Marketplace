/**
 * Spec 027 §3 / AC-11 — the one place a storage adapter is obtained inside a request.
 *
 * Its whole job is to turn a refused or unknown adapter into `503 FILE_STORAGE_UNAVAILABLE` and a
 * log line, so a misconfigured deployment answers loudly and nothing is ever marked `ready` behind
 * a storage backend that does not exist. Its own module rather than a helper inside `upload.ts`,
 * because the scan and sweep paths need it too and must not import the upload path to get it.
 */
import { logFileEvent } from './assets';
import { fileStorageUnavailableError } from './errors';
import { FileStorageUnavailable, resolveFileStorageAdapter, type FileStorageAdapter } from './storage';

export function adapterOrThrow(): FileStorageAdapter {
  try {
    return resolveFileStorageAdapter();
  } catch (err) {
    if (err instanceof FileStorageUnavailable) {
      logFileEvent('file.storage_unavailable', { reason: err.message });
      throw fileStorageUnavailableError(err.message);
    }
    throw err;
  }
}
