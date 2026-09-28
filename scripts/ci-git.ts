/**
 * Spec 046 §3.4 — the small git surface the diff-based CI checks share (`check:migration-pairing`,
 * `check:build-status`). Kept separate so the checks' logic can be tested with injected diffs.
 */
import { execFileSync } from 'node:child_process';

export interface ChangedFile {
  /** git's status letter: A, M, D, R (rename), C (copy), T … */
  status: string;
  path: string;
}

/** Parses `git diff --name-status` output. A rename/copy records its NEW path. */
export function parseNameStatus(text: string): ChangedFile[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [code, ...paths] = line.split('\t');
      return { status: code!.charAt(0), path: paths[paths.length - 1]! };
    });
}

/** A base ref that is absent, or git's all-zero "no previous commit" SHA, means there is nothing to diff. */
export function isUsableBase(base: string | undefined): base is string {
  return !!base && !/^0+$/.test(base);
}

export interface Git {
  changedFiles: (base: string) => ChangedFile[];
  /** File content at `ref`, or null when it does not exist there. */
  show: (ref: string, path: string) => string | null;
}

export const realGit: Git = {
  changedFiles: (base) => parseNameStatus(execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], { encoding: 'utf8' })),
  show: (ref, path) => {
    try {
      return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  },
};

/** `--base <ref>` from argv, else undefined. */
export function baseArg(args: readonly string[]): string | undefined {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1] : undefined;
}
