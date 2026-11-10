/**
 * Spec 046 AC-3 — a PR that changes `lib/db/schema.ts` must ship its reviewable SQL: a new
 * sequentially-numbered `drizzle/NNNN_<tag>.sql`, its hand-written `drizzle/NNNN_<tag>_down.sql`,
 * and the `drizzle/meta/_journal.json` entry for `<tag>`. (Every migration after 0015 in this
 * repository is hand-written, so `drizzle-kit generate` is not the gate — the diff is.)
 *
 * Usage: tsx scripts/check-migration-pairing.ts --base <ref>
 *   CI passes `origin/<base branch>` on a PR and the pushed range's `before` SHA on a push.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseArg, isUsableBase, realGit, type ChangedFile, type Git } from './ci-git';

export const SCHEMA_FILE = 'lib/db/schema.ts';
export const JOURNAL_FILE = 'drizzle/meta/_journal.json';
const MIGRATION = /^drizzle\/(\d{4}_[a-z0-9_]+?)(_down)?\.sql$/;

export function migrationPairingProblems(changed: readonly ChangedFile[], journalTags: readonly string[]): string[] {
  if (!changed.some((c) => c.path === SCHEMA_FILE && c.status !== 'D')) return [];

  const added = changed.filter((c) => c.status === 'A');
  const upTags = added.flatMap((c) => {
    const m = MIGRATION.exec(c.path);
    return m && !m[2] ? [m[1]!] : [];
  });
  const downTags = new Set(
    added.flatMap((c) => {
      const m = MIGRATION.exec(c.path);
      return m && m[2] ? [m[1]!] : [];
    }),
  );

  if (upTags.length === 0) return [`${SCHEMA_FILE} changed, but no new drizzle/NNNN_<tag>.sql migration was added.`];
  const problems: string[] = [];
  for (const tag of upTags) {
    if (!downTags.has(tag)) problems.push(`drizzle/${tag}.sql has no hand-written drizzle/${tag}_down.sql.`);
    if (!journalTags.includes(tag)) problems.push(`drizzle/${tag}.sql is not registered in ${JOURNAL_FILE}.`);
  }
  if (!changed.some((c) => c.path === JOURNAL_FILE)) problems.push(`${JOURNAL_FILE} was not updated.`);
  return problems;
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  readJournalTags: () => string[];
}

const defaultIo: Io = {
  log: console.log,
  error: console.error,
  readJournalTags: () =>
    (JSON.parse(readFileSync(join(__dirname, '..', JOURNAL_FILE), 'utf8')) as { entries: Array<{ tag: string }> }).entries.map((e) => e.tag),
};

export function run(args: readonly string[], git: Git = realGit, io: Io = defaultIo): number {
  const base = baseArg(args);
  if (!isUsableBase(base)) {
    io.log('check:migration-pairing — no base ref to diff against; skipped.');
    return 0;
  }
  const problems = migrationPairingProblems(git.changedFiles(base), io.readJournalTags());
  if (problems.length > 0) {
    io.error(`check:migration-pairing FAILED\n${problems.join('\n')}`);
    return 1;
  }
  io.log('check:migration-pairing — OK.');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-migration-pairing.ts')) {
  process.exit(run(process.argv.slice(2)));
}
