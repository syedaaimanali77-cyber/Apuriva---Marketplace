import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Spec 042 §6 "Boundary" — asserted on the TypeScript AST (not text), so a comment or a sentence that
 * merely mentions "PKR" or "en-US" is not a violation, and a real string literal cannot hide.
 */
const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const isProduction = (file: string) => !/\.(test|spec)\.tsx?$/.test(file) && !/test-support\.tsx?$/.test(file) && !file.includes(`${sep}e2e${sep}`);
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');

const PRODUCTION = ['app', 'lib', 'components'].flatMap((dir) => sourceFiles(join(ROOT, dir))).filter(isProduction);

const parsed = new Map<string, ts.SourceFile>();

/** Parsed once per file and shared by every scan below (the repository-wide scans are the slow part). */
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(file, source);
  }
  return source;
}

/** A repository-wide AST scan reads and parses every production file; generous under a loaded full suite. */
const REPO_SCAN_TIMEOUT_MS = 180_000;

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function stringText(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** §3.9 "Kept as they are" — documented defaults or fixtures, not architecture assumptions. */
const PKR_ALLOWED = new Set([
  'lib/config/currency.ts', // the configuration itself (PLATFORM_CURRENCY_CODE's documented default)
  'lib/ai/config.ts', // spec 033 AI_COST_CURRENCY_CODE's documented default
  'lib/ai/provider/sandbox.ts',
  'lib/payments/provider/sandbox.ts',
  'lib/payments/provider/sandbox-payout.ts',
]);

/** §3.6 — a FIXED parsing locale for time-zone validation and arithmetic, not display. */
const FIXED_LOCALE_ALLOWED = new Set(['lib/requests/create.ts', 'lib/availability/timezone.ts']);

const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
const INTL_CTORS = new Set(['NumberFormat', 'DateTimeFormat', 'RelativeTimeFormat', 'PluralRules', 'ListFormat', 'Collator']);

describe('spec 042 boundaries (§6)', () => {
  it('no business or UI logic falls back to a PKR literal outside the §3.9 kept list', () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION) {
      if (PKR_ALLOWED.has(rel(file))) continue;
      walk(parse(file), (node) => {
        if (stringText(node) === 'PKR') offenders.push(rel(file));
      });
    }
    expect(offenders).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it('the approved PKR fallbacks are gone (X-8, X-9, X-10)', () => {
    for (const file of [
      'lib/payouts/read.ts',
      'lib/payouts/statement.ts',
      'app/requests/new/[serviceId]/page.tsx',
      'app/admin/operations/payouts/page.tsx',
      'app/admin/operations/refunds/page.tsx',
    ]) {
      const literals: string[] = [];
      walk(parse(join(ROOT, file)), (node) => {
        const text = stringText(node);
        if (text !== null) literals.push(text);
      });
      expect(literals, file).not.toContain('PKR');
    }
  });

  it('no toLocale*/Intl.* call hard-codes a locale, except the two §3.6 time-zone modules', () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION) {
      if (FIXED_LOCALE_ALLOWED.has(rel(file))) continue;
      walk(parse(file), (node) => {
        if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
        const callee = node.expression;
        const firstArg = node.arguments?.[0];
        if (!firstArg || stringText(firstArg) === null) return;
        const isLocaleMethod = ts.isPropertyAccessExpression(callee) && LOCALE_METHODS.has(callee.name.text);
        const isIntl =
          ts.isPropertyAccessExpression(callee) &&
          INTL_CTORS.has(callee.name.text) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Intl';
        if (isLocaleMethod || isIntl) offenders.push(`${rel(file)}: ${node.getText().slice(0, 60)}`);
      });
    }
    expect(offenders).toEqual([]);
  }, REPO_SCAN_TIMEOUT_MS);

  it('the §3.6 time-zone modules keep their fixed en-US parsing locale (changing it would be a bug)', () => {
    expect(readFileSync(join(ROOT, 'lib/requests/create.ts'), 'utf8')).toContain("new Intl.DateTimeFormat('en-US', { timeZone })");
    expect(readFileSync(join(ROOT, 'lib/availability/timezone.ts'), 'utf8')).toContain("new Intl.DateTimeFormat('en-US', { timeZone })");
  });

  it('AC-2: lib/i18n never reaches search or AI input, and the input path never imports lib/i18n', () => {
    const i18n = sourceFiles(join(ROOT, 'lib', 'i18n')).filter(isProduction);
    for (const file of i18n) {
      const source = readFileSync(file, 'utf8');
      expect(source, rel(file)).not.toMatch(/from '@\/(lib\/(search|ai|ai-assistant|mcp|mcp-tools)|app\/api\/v1\/(search|ai))/);
    }
    const inputPath = [
      ...sourceFiles(join(ROOT, 'app', 'api', 'v1', 'search')),
      ...sourceFiles(join(ROOT, 'app', 'api', 'v1', 'ai')),
      ...sourceFiles(join(ROOT, 'lib', 'search')),
      ...sourceFiles(join(ROOT, 'lib', 'ai-assistant')),
    ].filter(isProduction);
    expect(inputPath.length).toBeGreaterThan(0);
    for (const file of inputPath) expect(readFileSync(file, 'utf8'), rel(file)).not.toMatch(/from '@\/lib\/i18n/);
  });

  it('no i18n library or translation-management dependency is added (master §133, D-2)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const i18nLibraries = /^(i18next|react-i18next|next-i18next|next-intl|react-intl|@formatjs\/|@lingui\/|rosetta|node-polyglot|typesafe-i18n|intl-messageformat|globalize|@tolgee\/|@crowdin\/|@phrase\/)/;
    expect(deps.filter((d) => i18nLibraries.test(d))).toEqual([]);
  });

  it('ui/ is not edited (§5.2: translated defaults go through components/ wrappers)', () => {
    let status: string;
    try {
      status = execFileSync('git', ['status', '--porcelain', '--', 'ui'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return; // no git available: nothing to assert against
    }
    expect(status.trim()).toBe('');
  });

  it('the directional-icon wrapper flips only through --rtl-flip, and customer pages use it for arrows/chevrons', () => {
    expect(readFileSync(join(ROOT, 'components/DirectionalIcon.tsx'), 'utf8')).toContain("transform: 'var(--rtl-flip, none)'");
    for (const file of [
      'app/account/page.tsx',
      'app/explore/page.tsx',
      'app/explore/[category]/page.tsx',
      'app/requests/new/[serviceId]/page.tsx',
      'app/requests/page.tsx',
      'app/requests/[id]/page.tsx',
    ]) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/<Icon name="(arrow-right|chevron-right)"/);
      expect(source, file).not.toMatch(/iconRight="(arrow-right|chevron-right)"/);
      expect(source, file).toMatch(/<DirectionalIcon name="(arrow-right|chevron-right)"/);
    }
  });

  it('the provider schedule table uses a logical text alignment (X-13)', () => {
    const css = readFileSync(join(ROOT, 'app/provider/schedule/schedule.module.css'), 'utf8');
    expect(css).not.toMatch(/text-align:\s*left/);
    expect(css).toMatch(/text-align:\s*start/);
  });
});
