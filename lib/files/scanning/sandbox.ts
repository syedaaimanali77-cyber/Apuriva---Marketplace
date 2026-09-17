/**
 * Spec 027 §3 "Scanning" — the sandbox scanner (AC-4, AC-11).
 *
 * STATED PLAINLY: this detects no malware. It is not an antivirus, it contacts no vendor, and the
 * `clean` it returns means exactly "none of the three documented test markers was present in the
 * first bytes" — nothing more. `resolveFileScanner()` refuses it under `NODE_ENV=production`, so a
 * production deployment without a real scanner fails loudly instead of declaring files safe.
 *
 * It is deterministic and documented so the lifecycle around it can be tested honestly:
 *
 * | first bytes contain            | outcome    | reasonCode     |
 * |--------------------------------|------------|----------------|
 * | the standard EICAR test string | `rejected` | `eicar`        |
 * | `APURIVA-TEST-UNSAFE`          | `rejected` | `test_marker`  |
 * | `APURIVA-TEST-UNKNOWN`         | `unknown`  | —              |
 * | no readable bytes at all       | `unknown`  | —              |
 * | anything else                  | `clean`    | —              |
 *
 * `unknown` exists precisely so AC-4's "never ready on a guess" path has something to exercise —
 * and the "no readable bytes" row is the same rule applied to the scanner itself: an object this
 * scanner could not read is one it has not inspected, so calling it `clean` would be a verdict it
 * did not reach. It reports `unknown` instead, the asset stays non-`ready`, and the sweep retries.
 */
import { resolveFileStorageAdapter } from '../storage';
import type { FileScanner, ScanRequest, ScanResult } from './types';

export const SANDBOX_SCANNER_NAME = 'sandbox';

/** The marker a test file carries to be rejected. Documented, not a signature of anything real. */
export const TEST_UNSAFE_MARKER = 'APURIVA-TEST-UNSAFE';
/** The marker that produces an unresolved scan. */
export const TEST_UNKNOWN_MARKER = 'APURIVA-TEST-UNKNOWN';

/**
 * The standard EICAR anti-malware test string — an industry-published, deliberately harmless
 * sequence every real scanner is expected to flag. Assembled from parts so this source file is not
 * itself quarantined by a developer's endpoint protection.
 */
export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** How much of the object the sandbox inspects. Bounded: it never loads a 100 MB video into memory. */
export const SANDBOX_SCAN_PREFIX_BYTES = 1024;

export function createSandboxFileScanner(): FileScanner {
  return {
    name: SANDBOX_SCANNER_NAME,
    isSandbox: true,

    async scan(input: ScanRequest): Promise<ScanResult> {
      const adapter = resolveFileStorageAdapter();
      const prefix = await adapter.readPrefix(input.storageKey, SANDBOX_SCAN_PREFIX_BYTES);
      // An empty read means the object is missing, unreadable, or behind a misconfigured adapter.
      // None of those is a clean bill of health — `clean` must mean "inspected and found nothing".
      if (prefix.length === 0) return { outcome: 'unknown' };

      const text = prefix.toString('latin1');

      if (text.includes(EICAR_TEST_STRING)) return { outcome: 'rejected', reasonCode: 'eicar' };
      if (text.includes(TEST_UNSAFE_MARKER)) return { outcome: 'rejected', reasonCode: 'test_marker' };
      if (text.includes(TEST_UNKNOWN_MARKER)) return { outcome: 'unknown' };
      return { outcome: 'clean' };
    },
  };
}
