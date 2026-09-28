/**
 * Spec 046 §3.5 — compares one or more Vitest JSON reports (`--reporter=json --outputFile=…`) with the
 * committed pre-existing-failure baseline `test/known-failures.json`, so the test jobs can be required
 * checks while failures owned by OTHER specs are still being fixed. It is a ratchet:
 *
 *   NEW failure  — a failing test not in the baseline                      → exit 1
 *   STALE entry  — a baseline entry whose file ran, and whose test passed
 *                  or no longer exists (fixed, renamed or removed)          → exit 1 ("remove it")
 *
 * Entries for files that did not run in this job are ignored: each CI job runs one test group.
 * A file that fails to load at all is reported as the pseudo-test "(file)".
 *
 * Usage: tsx scripts/check-test-baseline.ts <report.json> [more reports…] [--baseline test/known-failures.json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BaselineEntry {
  file: string;
  testName: string;
  owningSpec: string;
  classification: 'pre-existing' | 'environment' | 'load-flake';
  reason: string;
}

export interface Baseline {
  entries: BaselineEntry[];
}

/** The subset of Vitest's (Jest-compatible) JSON reporter output this check reads. */
export interface VitestJsonReport {
  testResults: Array<{
    name: string;
    status?: string;
    message?: string;
    assertionResults: Array<{ title: string; ancestorTitles?: string[]; fullName?: string; status: string }>;
  }>;
}

export interface TestOutcome {
  file: string;
  testName: string;
  passed: boolean;
}

export const FILE_LEVEL_TEST = '(file)';

/** Repo-relative, forward-slash path — separator-agnostic, so a Windows report reads the same on Linux CI. */
export function normalizeFile(name: string, root: string): string {
  const file = name.split('\\').join('/');
  const base = root.split('\\').join('/').replace(/\/+$/, '');
  const lower = (s: string) => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s);
  return lower(file).startsWith(`${lower(base)}/`) ? file.slice(base.length + 1) : file;
}

export function testNameOf(result: { title: string; ancestorTitles?: string[] }): string {
  return [...(result.ancestorTitles ?? []), result.title].join(' > ');
}

export function outcomesOf(report: VitestJsonReport, root: string): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const file of report.testResults) {
    const name = normalizeFile(file.name, root);
    if (file.assertionResults.length === 0) {
      outcomes.push({ file: name, testName: FILE_LEVEL_TEST, passed: file.status !== 'failed' });
      continue;
    }
    for (const result of file.assertionResults) {
      // Skipped/todo tests (for example DB-dependent suites without a database) are neither failures nor passes.
      if (result.status === 'passed' || result.status === 'failed') {
        outcomes.push({ file: name, testName: testNameOf(result), passed: result.status === 'passed' });
      }
    }
  }
  return outcomes;
}

export interface BaselineComparison {
  newFailures: TestOutcome[];
  staleEntries: BaselineEntry[];
  knownFailures: BaselineEntry[];
}

export function compareWithBaseline(outcomes: readonly TestOutcome[], baseline: Baseline): BaselineComparison {
  const key = (file: string, testName: string) => `${file}::${testName}`;
  const baselineKeys = new Set(baseline.entries.map((e) => key(e.file, e.testName)));
  const byKey = new Map(outcomes.map((o) => [key(o.file, o.testName), o] as const));
  const filesRun = new Set(outcomes.map((o) => o.file));

  const newFailures = outcomes.filter((o) => !o.passed && !baselineKeys.has(key(o.file, o.testName)));
  const staleEntries: BaselineEntry[] = [];
  const knownFailures: BaselineEntry[] = [];
  for (const entry of baseline.entries) {
    if (!filesRun.has(entry.file)) continue;
    const outcome = byKey.get(key(entry.file, entry.testName));
    if (outcome && !outcome.passed) knownFailures.push(entry);
    else staleEntries.push(entry);
  }
  return { newFailures, staleEntries, knownFailures };
}

export function validateBaseline(baseline: Baseline): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of baseline.entries) {
    const k = `${e.file}::${e.testName}`;
    if (seen.has(k)) problems.push(`duplicate entry ${k}`);
    seen.add(k);
    if (!e.file || !e.testName || !e.owningSpec || !e.reason) problems.push(`incomplete entry ${k}`);
    if (!['pre-existing', 'environment', 'load-flake'].includes(e.classification)) problems.push(`bad classification for ${k}`);
  }
  return problems;
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  readFile: (path: string) => string;
}

const defaultIo: Io = { log: console.log, error: console.error, readFile: (p) => readFileSync(p, 'utf8') };

export function run(args: readonly string[], root: string, io: Io = defaultIo): number {
  const baselineFlag = args.indexOf('--baseline');
  const baselinePath = baselineFlag >= 0 ? args[baselineFlag + 1]! : join(root, 'test', 'known-failures.json');
  const reports = args.filter((_, i) => baselineFlag < 0 || (i !== baselineFlag && i !== baselineFlag + 1));
  if (reports.length === 0) {
    io.error('Usage: tsx scripts/check-test-baseline.ts <report.json> [more…] [--baseline path]');
    return 2;
  }

  const baseline = JSON.parse(io.readFile(baselinePath)) as Baseline;
  const invalid = validateBaseline(baseline);
  if (invalid.length > 0) {
    io.error(`check-test-baseline: invalid baseline:\n${invalid.join('\n')}`);
    return 1;
  }

  const outcomes = reports.flatMap((r) => outcomesOf(JSON.parse(io.readFile(r)) as VitestJsonReport, root));
  const { newFailures, staleEntries, knownFailures } = compareWithBaseline(outcomes, baseline);

  io.log(`check-test-baseline: ${outcomes.length} tests, ${knownFailures.length} known pre-existing failure(s).`);
  for (const k of knownFailures) io.log(`  known (${k.owningSpec}, ${k.classification}): ${k.file} :: ${k.testName}`);
  if (newFailures.length === 0 && staleEntries.length === 0) {
    io.log('OK — no new failures and no stale baseline entries.');
    return 0;
  }
  for (const f of newFailures) io.error(`NEW FAILURE: ${f.file} :: ${f.testName}`);
  for (const s of staleEntries) io.error(`STALE BASELINE ENTRY (now passes or no longer exists — remove it): ${s.file} :: ${s.testName}`);
  return 1;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-test-baseline.ts')) {
  process.exit(run(process.argv.slice(2), join(__dirname, '..')));
}
