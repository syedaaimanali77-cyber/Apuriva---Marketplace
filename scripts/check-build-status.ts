/**
 * Spec 046 AC-7 / §3.12 — a PR that moves any `docs/specs/*.md` to `Approved` or `Implemented` must
 * also update `BUILD_STATUS.md` (master spec §129 step 12, §130).
 *
 * Usage: tsx scripts/check-build-status.ts --base <ref>
 */
import { baseArg, isUsableBase, realGit, type ChangedFile, type Git } from './ci-git';

export const BUILD_STATUS_FILE = 'BUILD_STATUS.md';
const COMPLETING_STATUSES = new Set(['Approved', 'Implemented']);
const SPEC_FILE = /^docs\/specs\/.+\.md$/;

/** The value of a spec's `**Status:** X` line, or null. */
export function specStatus(content: string | null): string | null {
  const m = content ? /^\*\*Status:\*\*\s*([A-Za-z]+)/m.exec(content) : null;
  return m ? m[1]! : null;
}

/** Specs this diff moves INTO Approved/Implemented. */
export function completedSpecs(changed: readonly ChangedFile[], base: string, git: Pick<Git, 'show'>): string[] {
  return changed
    .filter((c) => (c.status === 'A' || c.status === 'M' || c.status === 'R') && SPEC_FILE.test(c.path))
    .filter((c) => {
      const after = specStatus(git.show('HEAD', c.path));
      return after !== null && COMPLETING_STATUSES.has(after) && after !== specStatus(git.show(base, c.path));
    })
    .map((c) => c.path);
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function run(args: readonly string[], git: Git = realGit, io: Io = { log: console.log, error: console.error }): number {
  const base = baseArg(args);
  if (!isUsableBase(base)) {
    io.log('check:build-status — no base ref to diff against; skipped.');
    return 0;
  }
  const changed = git.changedFiles(base);
  const completed = completedSpecs(changed, base, git);
  if (completed.length > 0 && !changed.some((c) => c.path === BUILD_STATUS_FILE)) {
    io.error(`check:build-status FAILED — ${completed.join(', ')} moved to Approved/Implemented without updating ${BUILD_STATUS_FILE}.`);
    return 1;
  }
  io.log('check:build-status — OK.');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-build-status.ts')) {
  process.exit(run(process.argv.slice(2)));
}
