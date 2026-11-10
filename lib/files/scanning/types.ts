/**
 * Spec 027 §3 "Scanning" (AC-4) — the malware/security-check capability contract.
 *
 * This repository has no antivirus vendor, account or engine. It ships exactly one implementation,
 * a deterministic sandbox that claims NO detection capability and refuses to run under
 * `NODE_ENV=production` (AC-11). A later spec supplies a real scanner behind this interface.
 */
import type { ScanOutcome } from '@/lib/types/files';

export type { ScanOutcome };

export interface ScanRequest {
  fileAssetId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ScanResult {
  outcome: ScanOutcome;
  /** A CODE, never scanner internals — it is surfaced to the owner as `rejection_reason`. */
  reasonCode?: string;
}

export interface FileScanner {
  readonly name: string;
  /** True for a scanner that detects nothing real. The factory refuses one in production. */
  readonly isSandbox?: boolean;
  scan(input: ScanRequest): Promise<ScanResult>;
}

/** Raised instead of falling back, so a misconfiguration fails loudly rather than skipping a scan. */
export class FileScannerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileScannerUnavailable';
  }
}
