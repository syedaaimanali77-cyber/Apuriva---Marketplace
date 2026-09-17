/**
 * Spec 027 §3 "Scanning" — scanner selection and AC-11's production guard, the same shape as the
 * storage seam next door.
 *
 * Selected by `FILE_SCANNER` (default `sandbox`). An unknown name throws rather than falling back:
 * a mistyped variable must never silently downgrade to a scanner that detects nothing. A sandbox
 * under `NODE_ENV=production` throws for the same reason.
 */
import { createSandboxFileScanner } from './sandbox';
import type { FileScanner } from './types';
import { FileScannerUnavailable } from './types';

export type { FileScanner, ScanRequest, ScanResult, ScanOutcome } from './types';
export { FileScannerUnavailable } from './types';
export {
  createSandboxFileScanner,
  EICAR_TEST_STRING,
  SANDBOX_SCAN_PREFIX_BYTES,
  SANDBOX_SCANNER_NAME,
  TEST_UNKNOWN_MARKER,
  TEST_UNSAFE_MARKER,
} from './sandbox';

export const FILE_SCANNER_ENV_VAR = 'FILE_SCANNER';
const DEFAULT_SCANNER = 'sandbox';

/** The scanners this repository actually has. A real vendor registers its name here. */
const SCANNERS: Record<string, () => FileScanner> = {
  sandbox: createSandboxFileScanner,
};

/** Read fresh on every call: a cached scanner would let whichever call warmed it bypass the guard. */
export function resolveFileScanner(): FileScanner {
  const configured = (process.env.FILE_SCANNER ?? '').trim() || DEFAULT_SCANNER;
  const factory = SCANNERS[configured];
  if (!factory) {
    throw new FileScannerUnavailable(`${FILE_SCANNER_ENV_VAR}="${configured}" is not a known file scanner.`);
  }
  const scanner = factory();
  if (process.env.NODE_ENV === 'production' && scanner.isSandbox) {
    throw new FileScannerUnavailable(
      `The "${configured}" file scanner is a sandbox and must never run in production. Configure a real malware scanner.`,
    );
  }
  return scanner;
}
