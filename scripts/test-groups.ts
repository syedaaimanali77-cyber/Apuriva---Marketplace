/**
 * Spec 046 §3.4 — assigns every Vitest file to exactly one CI test group, so each master-§114 stage
 * (unit, integration, MCP, security/permission, route-level E2E) is its own named, required check and
 * no file runs twice or never.
 *
 * Precedence: mcp > security > e2e-route > integration > unit. Discovery mirrors `vitest.config.ts`
 * (`**∕*.test.{ts,tsx}` and `e2e/**∕*.spec.{ts,tsx}`, excluding node_modules, .next, drizzle and the
 * Playwright `browser/` directory).
 *
 * Usage:
 *   tsx scripts/test-groups.ts <unit|integration|mcp|security|e2e-route>   prints that group's files
 *   tsx scripts/test-groups.ts --check                                      validates the grouping
 *
 * Vitest treats path arguments as substring filters, so `--check` also fails when a file path is a
 * substring of a file in ANOTHER group (that file would silently run in both jobs).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TEST_GROUPS = ['unit', 'integration', 'mcp', 'security', 'e2e-route'] as const;
export type TestGroup = (typeof TEST_GROUPS)[number];

const IGNORED_DIRS = new Set(['node_modules', '.next', 'drizzle', 'browser', '.git', 'coverage', 'playwright-report', 'test-results']);
const SECURITY_WORDS = ['access', 'permission', 'boundary', 'security', 'csrf', 'authorization', 'rbac', 'ownership'];
const MCP_PREFIXES = ['lib/mcp/', 'lib/mcp-tools/', 'lib/ai-assistant/'];

export function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file) || (file.startsWith('e2e/') && /\.spec\.tsx?$/.test(file));
}

export function groupOf(file: string): TestGroup {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  if (MCP_PREFIXES.some((p) => file.startsWith(p)) || /^app\/api\/v1\/(.+\/)?mcp\//.test(file)) return 'mcp';
  if (SECURITY_WORDS.some((word) => base.includes(word))) return 'security';
  if (file.startsWith('e2e/')) return 'e2e-route';
  if (/\.integration\.test\.tsx?$/.test(file)) return 'integration';
  return 'unit';
}

export function collectTestFiles(root: string, dir: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) collectTestFiles(root, full, out);
      continue;
    }
    const rel = relative(root, full).split('\\').join('/');
    if (isTestFile(rel)) out.push(rel);
  }
  return out.sort();
}

export function groupFiles(files: readonly string[]): Record<TestGroup, string[]> {
  const groups = Object.fromEntries(TEST_GROUPS.map((g) => [g, [] as string[]])) as Record<TestGroup, string[]>;
  for (const file of files) groups[groupOf(file)].push(file);
  return groups;
}

/** Problems that would make a file run in two jobs, or in none. Empty when the grouping is sound. */
export function groupingProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  const groupByFile = new Map(files.map((f) => [f, groupOf(f)] as const));
  for (const filter of files) {
    for (const other of files) {
      if (other !== filter && other.includes(filter) && groupByFile.get(other) !== groupByFile.get(filter)) {
        problems.push(`"${filter}" (${groupByFile.get(filter)}) also matches "${other}" (${groupByFile.get(other)})`);
      }
    }
  }
  return problems;
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
}

export function run(args: readonly string[], root: string, io: Io = { log: console.log, error: console.error }): number {
  const files = collectTestFiles(root);
  const arg = args[0];
  if (arg === '--check') {
    const problems = groupingProblems(files);
    const groups = groupFiles(files);
    for (const g of TEST_GROUPS) io.log(`${g}: ${groups[g].length}`);
    if (problems.length > 0) {
      io.error(`test-groups: ${problems.length} problem(s):\n${problems.join('\n')}`);
      return 1;
    }
    io.log(`OK — ${files.length} test files, each in exactly one group.`);
    return 0;
  }
  if (!TEST_GROUPS.includes(arg as TestGroup)) {
    io.error(`Usage: tsx scripts/test-groups.ts <${TEST_GROUPS.join('|')}> | --check`);
    return 2;
  }
  const selected = groupFiles(files)[arg as TestGroup];
  if (selected.length === 0) {
    io.error(`test-groups: group "${arg}" is empty`);
    return 1;
  }
  io.log(selected.join('\n'));
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/test-groups.ts')) {
  process.exit(run(process.argv.slice(2), join(__dirname, '..')));
}
