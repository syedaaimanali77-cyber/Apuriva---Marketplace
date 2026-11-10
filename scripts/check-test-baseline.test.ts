import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Baseline, BaselineEntry, VitestJsonReport } from './check-test-baseline';
import { compareWithBaseline, FILE_LEVEL_TEST, normalizeFile, outcomesOf, run, testNameOf, validateBaseline } from './check-test-baseline';

const ROOT = '/repo';

const entry = (file: string, testName: string): BaselineEntry => ({
  file,
  testName,
  owningSpec: '003',
  classification: 'pre-existing',
  reason: 'pins a stale table list',
});

const report: VitestJsonReport = {
  testResults: [
    {
      name: '/repo/lib/a.test.ts',
      assertionResults: [
        { title: 'passes', ancestorTitles: ['suite'], status: 'passed' },
        { title: 'known', ancestorTitles: ['suite'], status: 'failed' },
        { title: 'brand new', ancestorTitles: ['suite'], status: 'failed' },
        { title: 'skipped', ancestorTitles: ['suite'], status: 'skipped' },
      ],
    },
    { name: '/repo/lib/broken.test.ts', status: 'failed', message: 'SyntaxError', assertionResults: [] },
    { name: 'lib/fixed.test.ts', assertionResults: [{ title: 'now passes', status: 'passed' }] },
  ],
};

describe('check-test-baseline (spec 046 §3.5)', () => {
  it('normalizes absolute POSIX and Windows paths, keeps relative ones', () => {
    expect(normalizeFile('/repo/lib/a.test.ts', ROOT)).toBe('lib/a.test.ts');
    expect(normalizeFile('lib/a.test.ts', ROOT)).toBe('lib/a.test.ts');
    expect(normalizeFile('C:\\repo\\lib\\a.test.ts', 'C:\\repo')).toBe('lib/a.test.ts');
    expect(testNameOf({ title: 't', ancestorTitles: ['a', 'b'] })).toBe('a > b > t');
    expect(testNameOf({ title: 't' })).toBe('t');
  });

  it('reads pass/fail outcomes, ignores skipped tests, and reports a file that failed to load', () => {
    const outcomes = outcomesOf(report, ROOT);
    expect(outcomes).toContainEqual({ file: 'lib/a.test.ts', testName: 'suite > passes', passed: true });
    expect(outcomes).toContainEqual({ file: 'lib/broken.test.ts', testName: FILE_LEVEL_TEST, passed: false });
    expect(outcomes.some((o) => o.testName.endsWith('skipped'))).toBe(false);
  });

  it('flags new failures and stale entries; accepts known failures; ignores entries for files that did not run', () => {
    const baseline: Baseline = {
      entries: [
        entry('lib/a.test.ts', 'suite > known'),
        entry('lib/fixed.test.ts', 'now passes'),
        entry('lib/a.test.ts', 'suite > renamed away'),
        entry('lib/not-in-this-job.test.ts', 'x'),
      ],
    };
    const result = compareWithBaseline(outcomesOf(report, ROOT), baseline);
    expect(result.newFailures.map((f) => f.testName).sort()).toEqual([FILE_LEVEL_TEST, 'suite > brand new']);
    expect(result.knownFailures.map((k) => k.testName)).toEqual(['suite > known']);
    expect(result.staleEntries.map((s) => s.testName).sort()).toEqual(['now passes', 'suite > renamed away']);
  });

  it('validates the baseline file itself', () => {
    const bad = { entries: [entry('a', 'b'), entry('a', 'b'), { ...entry('c', 'd'), reason: '' }, { ...entry('e', 'f'), classification: 'whatever' }] } as Baseline;
    expect(validateBaseline(bad)).toEqual(['duplicate entry a::b', 'incomplete entry c::d', 'bad classification for e::f']);
  });

  it('the committed test/known-failures.json is valid', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'test', 'known-failures.json'), 'utf8')) as Baseline;
    expect(validateBaseline(committed)).toEqual([]);
  });

  describe('run', () => {
    function io(files: Record<string, string>) {
      const out: string[] = [];
      const err: string[] = [];
      return { io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), readFile: (p: string) => files[p]! }, out, err };
    }
    const clean: VitestJsonReport = { testResults: [{ name: '/repo/lib/a.test.ts', assertionResults: [{ title: 'ok', status: 'passed' }] }] };

    it('exits 0 with no new failures and no stale entries', () => {
      const t = io({ 'r.json': JSON.stringify(clean), 'b.json': JSON.stringify({ entries: [] }) });
      expect(run(['r.json', '--baseline', 'b.json'], ROOT, t.io)).toBe(0);
      expect(t.out.at(-1)).toMatch(/^OK/);
    });

    it('exits 1 and names every new failure and stale entry', () => {
      const t = io({ 'r.json': JSON.stringify(report), 'b.json': JSON.stringify({ entries: [entry('lib/fixed.test.ts', 'now passes')] }) });
      expect(run(['r.json', '--baseline', 'b.json'], ROOT, t.io)).toBe(1);
      expect(t.err.some((l) => l.startsWith('NEW FAILURE: lib/a.test.ts :: suite > brand new'))).toBe(true);
      expect(t.err.some((l) => l.startsWith('STALE BASELINE ENTRY'))).toBe(true);
    });

    it('uses test/known-failures.json by default and reads every report given', () => {
      const t = io({
        'r1.json': JSON.stringify(clean),
        'r2.json': JSON.stringify(report),
        [join(ROOT, 'test', 'known-failures.json')]: JSON.stringify({ entries: [] }),
      });
      expect(run(['r1.json', 'r2.json'], ROOT, t.io)).toBe(1);
      expect(t.err.some((l) => l.includes('suite > brand new'))).toBe(true);
    });

    it('exits 1 on an invalid baseline and 2 without reports', () => {
      const t = io({ 'r.json': JSON.stringify(clean), 'b.json': JSON.stringify({ entries: [entry('a', 'b'), entry('a', 'b')] }) });
      expect(run(['r.json', '--baseline', 'b.json'], ROOT, t.io)).toBe(1);
      expect(run(['--baseline', 'b.json'], ROOT, io({}).io)).toBe(2);
    });
  });
});
