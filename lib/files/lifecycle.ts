/**
 * Spec 027 §3 "Upload lifecycle" (AC-4, AC-7) — the pure lifecycle policy. No I/O here: the upload,
 * scan and sweep modules apply what this decides, and migration 0023's C-4/C-5/C-6/C-12 enforce the
 * same rules at the database so application code is never the only thing holding them.
 *
 *     pending ──► scanning ──► ready       (scan: clean)
 *                         └──► rejected    (scan: rejected, or a failed actual-object check)
 *                         └──► scanning    (scan: unknown — retried, NEVER ready)
 *
 * `ready` and `rejected` are terminal. `unknown` is not a verdict: it counts an attempt and leaves
 * the asset unreadable by everyone, which is the whole of AC-4's "never ready on a guess".
 */
import type { FileStatus, ScanOutcome } from '@/lib/types/files';
import { scanMaxAttempts } from './config';

export const TERMINAL_FILE_STATUSES: readonly FileStatus[] = ['ready', 'rejected'];

export function isTerminalStatus(status: FileStatus): boolean {
  return TERMINAL_FILE_STATUSES.includes(status);
}

/** The only transitions this spec permits. Anything absent here is refused before it reaches SQL. */
const ALLOWED_TRANSITIONS: Record<FileStatus, readonly FileStatus[]> = {
  pending: ['scanning', 'rejected'],
  // `scanning -> scanning` is the `unknown` retry: a real, repeatable step, not a no-op.
  scanning: ['scanning', 'ready', 'rejected'],
  ready: [],
  rejected: [],
};

export function canTransition(from: FileStatus, to: FileStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Only a `ready` asset is readable by anyone — including its owner (§3 "Upload lifecycle"). */
export function isReadable(status: FileStatus): boolean {
  return status === 'ready';
}

/**
 * Minutes to wait after the `attempts`-th scan attempt: 2, 4, 8, 16, … — the same `2^attempts`
 * schedule spec 026's delivery retry uses, so an operator reads one backoff rule, not two.
 */
export function scanBackoffMinutes(attempts: number): number {
  return 2 ** Math.max(1, attempts);
}

export type ScanDecision =
  /** `clean` — the one path to `ready`, and only ever from a real scanner verdict. */
  | { status: 'ready' }
  /** `rejected` — terminal, bytes purged immediately, a reason CODE recorded (never scanner internals). */
  | { status: 'rejected'; reasonCode: string }
  /** `unknown`/throw below the ceiling — stays `scanning`, retried by the sweep. */
  | { status: 'scanning'; retryInMinutes: number }
  /** At the ceiling: still `scanning` (never a guessed terminal), no longer auto-claimed, logged for an operator. */
  | { status: 'scanning'; retryInMinutes: null; exhausted: true };

/** `attempts` is the count INCLUDING the attempt that just produced `outcome`. */
export function decideAfterScan(outcome: ScanOutcome, attempts: number, reasonCode?: string): ScanDecision {
  if (outcome === 'clean') return { status: 'ready' };
  if (outcome === 'rejected') return { status: 'rejected', reasonCode: reasonCode ?? 'scan_rejected' };

  // `unknown`, or a scanner that threw: never a terminal state on a guess (AC-4).
  if (attempts >= scanMaxAttempts()) return { status: 'scanning', retryInMinutes: null, exhausted: true };
  return { status: 'scanning', retryInMinutes: scanBackoffMinutes(attempts) };
}
