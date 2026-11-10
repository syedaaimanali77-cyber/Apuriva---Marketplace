import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectTestFiles, groupFiles, groupingProblems, groupOf, isTestFile, run } from './test-groups';

const REPO_ROOT = join(__dirname, '..');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) }, out, err };
}

describe('test groups (spec 046 §3.4)', () => {
  it.each([
    ['lib/mcp/authorize.test.ts', 'mcp'],
    ['lib/mcp-tools/catalog.integration.test.ts', 'mcp'],
    ['lib/ai-assistant/turns.test.ts', 'mcp'],
    ['app/api/v1/admin/mcp/tools/route.integration.test.ts', 'mcp'],
    ['app/api/v1/admin/feature-flags/access.integration.test.ts', 'security'],
    ['lib/feature-flags/boundary.test.ts', 'security'],
    ['lib/auth/csrf.test.ts', 'security'],
    ['e2e/auth.spec.ts', 'e2e-route'],
    ['lib/cron/heartbeats.integration.test.ts', 'integration'],
    ['lib/cron/route.test.ts', 'unit'],
    ['app/(auth)/login/page.test.tsx', 'unit'],
  ])('%s → %s', (file, group) => {
    expect(groupOf(file)).toBe(group);
  });

  it('mirrors vitest.config.ts discovery', () => {
    expect(isTestFile('lib/a.test.ts')).toBe(true);
    expect(isTestFile('app/b.test.tsx')).toBe(true);
    expect(isTestFile('e2e/c.spec.ts')).toBe(true);
    expect(isTestFile('lib/d.spec.ts')).toBe(false);
    expect(isTestFile('browser/smoke.browser.ts')).toBe(false);
    expect(isTestFile('lib/e.ts')).toBe(false);
  });

  it('detects a filter that would also select a file in another group', () => {
    expect(groupingProblems(['lib/x.test.ts', 'lib/x.test.tsx'])).toEqual([]);
    const problems = groupingProblems(['lib/a/csrf.test.ts', 'lib/a/csrf.test.tsx', 'lib/cron.test.ts', 'lib/mcp/lib/cron.test.ts']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('lib/cron.test.ts');
  });

  it('every real test file lands in exactly one group, with no cross-group filter collision, and browser/ is excluded', () => {
    const files = collectTestFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith('browser/'))).toBe(false);
    const groups = groupFiles(files);
    expect(Object.values(groups).reduce((n, g) => n + g.length, 0)).toBe(files.length);
    expect(groupingProblems(files)).toEqual([]);
    for (const g of Object.values(groups)) expect(g.length).toBeGreaterThan(0);
  });

  describe('run', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    function fixture(files: string[]): string {
      tmp = mkdtempSync(join(tmpdir(), 'test-groups-'));
      for (const f of files) {
        mkdirSync(dirname(join(tmp, f)), { recursive: true });
        writeFileSync(join(tmp, f), '');
      }
      return tmp;
    }

    it('--check passes on the repository', () => {
      const { io, out } = capture();
      expect(run(['--check'], REPO_ROOT, io)).toBe(0);
      expect(out.at(-1)).toMatch(/^OK/);
    });

    it('--check fails on a colliding fixture', () => {
      const root = fixture(['lib/cron.test.ts', 'lib/mcp/lib/cron.test.ts']);
      const { io, err } = capture();
      expect(run(['--check'], root, io)).toBe(1);
      expect(err[0]).toMatch(/problem/);
    });

    it('prints one group, newline-separated; refuses an unknown or empty group', () => {
      const root = fixture(['lib/a.test.ts', 'lib/b.integration.test.ts', 'node_modules/z.test.ts', 'browser/s.browser.ts']);
      const unit = capture();
      expect(run(['unit'], root, unit.io)).toBe(0);
      expect(unit.out).toEqual(['lib/a.test.ts']);
      const bad = capture();
      expect(run(['nope'], root, bad.io)).toBe(2);
      const empty = capture();
      expect(run(['mcp'], root, empty.io)).toBe(1);
    });
  });
});
