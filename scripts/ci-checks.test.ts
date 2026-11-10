import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseArg, isUsableBase, parseNameStatus, realGit, type ChangedFile, type Git } from './ci-git';
import { migrationPairingProblems, run as runMigrationPairing } from './check-migration-pairing';
import { completedSpecs, run as runBuildStatus, specStatus } from './check-build-status';
import { repoFs, run as runNoWorkspace, workspaceProblems } from './check-no-workspace';

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
};

describe('ci-git helpers', () => {
  it('parses git diff --name-status, keeping a rename’s new path', () => {
    expect(parseNameStatus('M\tlib/db/schema.ts\nA\tdrizzle/0039_x.sql\r\nR100\told.md\tnew.md\n\n')).toEqual([
      { status: 'M', path: 'lib/db/schema.ts' },
      { status: 'A', path: 'drizzle/0039_x.sql' },
      { status: 'R', path: 'new.md' },
    ]);
  });

  it('treats a missing or all-zero base as nothing to diff', () => {
    expect(isUsableBase(undefined)).toBe(false);
    expect(isUsableBase('0000000000000000000000000000000000000000')).toBe(false);
    expect(isUsableBase('origin/main')).toBe(true);
    expect(baseArg(['--base', 'origin/main'])).toBe('origin/main');
    expect(baseArg([])).toBeUndefined();
  });
});

describe('realGit — the adapter CI runs against this repository', () => {
  it('reads a committed file at a ref, and answers null for a path that does not exist there', () => {
    expect(realGit.show('HEAD', 'package.json')).toContain('"name": "apuriva"');
    expect(realGit.show('HEAD', 'no/such/file.txt')).toBeNull();
  });

  it('lists no changed files between a commit and itself', () => {
    expect(realGit.changedFiles('HEAD')).toEqual([]);
  });
});

describe('check:migration-pairing (spec 046 AC-3)', () => {
  const schema: ChangedFile = { status: 'M', path: 'lib/db/schema.ts' };
  const journal: ChangedFile = { status: 'M', path: 'drizzle/meta/_journal.json' };
  const up: ChangedFile = { status: 'A', path: 'drizzle/0039_add_widgets.sql' };
  const down: ChangedFile = { status: 'A', path: 'drizzle/0039_add_widgets_down.sql' };

  it('passes when the schema is untouched', () => {
    expect(migrationPairingProblems([{ status: 'M', path: 'lib/x.ts' }], [])).toEqual([]);
  });

  it('passes with migration, down file and journal entry', () => {
    expect(migrationPairingProblems([schema, up, down, journal], ['0039_add_widgets'])).toEqual([]);
  });

  it('fails a schema change with no migration', () => {
    expect(migrationPairingProblems([schema], [])).toEqual(['lib/db/schema.ts changed, but no new drizzle/NNNN_<tag>.sql migration was added.']);
  });

  it('fails a missing down file, a missing journal entry, and an untouched journal', () => {
    expect(migrationPairingProblems([schema, up], [])).toEqual([
      'drizzle/0039_add_widgets.sql has no hand-written drizzle/0039_add_widgets_down.sql.',
      'drizzle/0039_add_widgets.sql is not registered in drizzle/meta/_journal.json.',
      'drizzle/meta/_journal.json was not updated.',
    ]);
  });

  it('the committed 0038 migration satisfies the rule', () => {
    const changed: ChangedFile[] = [
      schema,
      journal,
      { status: 'A', path: 'drizzle/0038_add_cron_job_heartbeats.sql' },
      { status: 'A', path: 'drizzle/0038_add_cron_job_heartbeats_down.sql' },
    ];
    const t = { ...io(), readJournalTags: () => ['0037_add_user_locale', '0038_add_cron_job_heartbeats'] };
    const git: Git = { changedFiles: () => changed, show: () => null };
    expect(runMigrationPairing(['--base', 'origin/main'], git, t)).toBe(0);
    expect(runMigrationPairing(['--base', 'origin/main'], { ...git, changedFiles: () => [schema] }, t)).toBe(1);
    expect(runMigrationPairing([], git, t)).toBe(0);
    expect(t.out[t.out.length - 1]).toMatch(/skipped/);
  });
});

describe('check:build-status (spec 046 AC-7)', () => {
  const spec = (status: string) => `# Spec\n\n**File:** x\n**Status:** ${status}\n`;

  it('reads a spec status line', () => {
    expect(specStatus(spec('Approved'))).toBe('Approved');
    expect(specStatus('no status here')).toBeNull();
    expect(specStatus(null)).toBeNull();
  });

  it('finds specs moved INTO Approved/Implemented only', () => {
    const contents: Record<string, string> = {
      'HEAD:docs/specs/a.md': spec('Approved'),
      'base:docs/specs/a.md': spec('Draft'),
      'HEAD:docs/specs/b.md': spec('Approved'),
      'base:docs/specs/b.md': spec('Approved'),
      'HEAD:docs/specs/c.md': spec('Implemented'),
      'HEAD:docs/specs/d.md': spec('Draft'),
    };
    const show = (ref: string, path: string) => contents[`${ref}:${path}`] ?? null;
    const changed: ChangedFile[] = [
      { status: 'M', path: 'docs/specs/a.md' },
      { status: 'M', path: 'docs/specs/b.md' },
      { status: 'A', path: 'docs/specs/c.md' },
      { status: 'M', path: 'docs/specs/d.md' },
      { status: 'D', path: 'docs/specs/e.md' },
      { status: 'M', path: 'docs/workflow.md' },
    ];
    expect(completedSpecs(changed, 'base', { show })).toEqual(['docs/specs/a.md', 'docs/specs/c.md']);
  });

  it('fails without BUILD_STATUS.md, passes with it, skips without a base', () => {
    const show = (ref: string) => (ref === 'HEAD' ? spec('Approved') : spec('Draft'));
    const specChange: ChangedFile = { status: 'M', path: 'docs/specs/x.md' };
    const t = io();
    expect(runBuildStatus(['--base', 'b'], { changedFiles: () => [specChange], show }, t)).toBe(1);
    expect(t.err[0]).toMatch(/BUILD_STATUS\.md/);
    expect(runBuildStatus(['--base', 'b'], { changedFiles: () => [specChange, { status: 'M', path: 'BUILD_STATUS.md' }], show }, t)).toBe(0);
    expect(runBuildStatus([], { changedFiles: () => [], show }, t)).toBe(0);
  });
});

describe('check:no-workspace (spec 001 AC-2)', () => {
  it('passes on this repository', () => {
    const t = io();
    expect(runNoWorkspace(repoFs(join(__dirname, '..')), t)).toBe(0);
  });

  it('fails on workspace tooling or a workspaces field', () => {
    expect(workspaceProblems({ exists: (p) => p === 'turbo.json' || p === 'packages', readPackageJson: () => ({ workspaces: ['a'] }) })).toEqual([
      'turbo.json exists',
      'packages exists',
      'package.json declares "workspaces"',
    ]);
    const t = io();
    expect(runNoWorkspace({ exists: () => false, readPackageJson: () => ({ workspaces: [] }) }, t)).toBe(1);
  });
});
