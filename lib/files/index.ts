/**
 * Spec 027 — the files domain barrel. `registerFileIntegration()` is called from
 * `instrumentation.ts` (the composition root specs 021–026 already use).
 *
 * Dependency direction: spec 027 → shared infrastructure, spec 008's storage PORT, and the
 * read-only authorization helpers its shipped context policies delegate to. A consuming spec never
 * learns how a file is stored or scanned, and this spec never encodes a consuming spec's rule about
 * when a file is required — that stays with 015/020/025/028/031 and the portfolio spec (§7).
 */
export { adapterOrThrow } from './adapter';
export { issueFileUrl, loadReadableAsset, serveFileContent, type ContentResponse } from './access';
export {
  countContextAssets,
  FILE_ASSET_COLUMNS,
  findLiveAsset,
  logFileEvent,
  toFileAssetDto,
  type FileAssetRow,
} from './assets';
export { maxBytesFor, purgeGraceDays, scanMaxAttempts, signedUrlTtlSeconds, uploadUrlTtlSeconds } from './config';
export {
  getFileContextPolicy,
  registerFileContextPolicy,
  registeredFileContextTypes,
  resetFileContextPolicies,
  type FileContextPolicy,
} from './contexts/registry';
export {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_PORTFOLIO_ASSETS,
  MAX_REQUEST_ATTACHMENTS,
  registerShippedFileContextPolicies,
} from './contexts/policies';
export { deleteFileAsset, redactFileAssetsForDeletedUser } from './deletion';
export { canTransition, decideAfterScan, isReadable, isTerminalStatus, scanBackoffMinutes } from './lifecycle';
export { exportFileAssetData, type ExportedFileAsset } from './privacy';
export { runScanForAsset } from './scan';
export { resolveFileScanner, FileScannerUnavailable } from './scanning';
export { resolveFileStorageAdapter, FileStorageUnavailable, type FileStorageAdapter } from './storage';
export { registerFileAssetStoragePort, exportStorageKey } from './storage/legacy-port';
export { runFileMaintenanceSweep, type FileMaintenanceSweepResult } from './sweep';
export { createUploadTarget, finalizeUpload, parseUploadUrlRequest } from './upload';
export {
  ALLOWED_MIME_TYPES,
  allowedMimeTypes,
  sanitizeFileName,
  sniffMimeType,
  validateActualObject,
  validateDeclaredUpload,
} from './validation';

import { registerShippedFileContextPolicies } from './contexts/policies';
import { registerFileAssetStoragePort } from './storage/legacy-port';

/**
 * Wires spec 027 into the application: spec 008's storage port (AC-10) and the three shipped
 * context policies (AC-8). Idempotent — both registrations replace rather than accumulate, so a
 * hot-reloaded dev server and a repeated call converge on the same state.
 *
 * Rolling spec 027 back returns spec 008's port to throwing, which is exactly its documented
 * pre-027 behaviour (§9 "Rollback"), so no shipped spec breaks.
 */
export function registerFileIntegration(): void {
  registerFileAssetStoragePort();
  registerShippedFileContextPolicies();
}
