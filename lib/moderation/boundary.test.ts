import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 038 §6 "Boundary" — the architectural guarantees, asserted at source level.
 *
 * These are the checks that keep ownership where the spec puts it: lifecycle values have ONE writer,
 * signals cannot reach enforcement, booking state stays spec 020/023's, payouts stay spec 024's, and
 * the enforcement points import only the leaf standing module.
 */
const ROOT = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.includes('test-support')) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).replace(/\\/g, '/');
}

/** Executable text only: line comments and block comments stripped. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const PRODUCTION = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))];
const MODERATION = walk(join(ROOT, 'lib', 'moderation'));

describe('spec 038 boundaries', () => {
  it('has production sources to check', () => {
    expect(MODERATION.length).toBeGreaterThan(10);
  });

  it('AC-1: only lib/moderation/lifecycle.ts writes a sanction value to a lifecycle column', () => {
    const writes = /(SET\s+lifecycle_status\s*=|lifecycleStatus\s*:)\s*[^,\n]*('restricted'|'suspended'|'banned'|\$\{standing\}|standing\b)/i;
    const offenders = PRODUCTION.filter((file) => rel(file) !== 'lib/moderation/lifecycle.ts' && writes.test(code(file))).map(rel);
    expect(offenders).toEqual([]);
    expect(code(join(ROOT, 'lib', 'moderation', 'lifecycle.ts'))).toMatch(/UPDATE users SET lifecycle_status/);
  });

  it('only the action service calls the lifecycle module', () => {
    // `./lifecycle` counts only inside lib/moderation — other domains have lifecycle modules of their own.
    const importsIt = (file: string) =>
      /from '@\/lib\/moderation\/lifecycle'/.test(code(file)) ||
      (rel(file).startsWith('lib/moderation/') && /from '\.\/lifecycle'/.test(code(file)));
    const offenders = PRODUCTION.filter((file) => rel(file) !== 'lib/moderation/actions.ts' && importsIt(file)).map(rel);
    expect(offenders).toEqual([]);
  });

  it('AC-3: the signal modules cannot reach enforcement', () => {
    for (const name of ['fraud-signals.ts', 'rules.ts']) {
      const source = code(join(ROOT, 'lib', 'moderation', name));
      expect(source).not.toMatch(/from '\.\/(actions|lifecycle|sessions|index)'/);
      expect(source).not.toMatch(/authorizeAndInitiate|executeApprovedAction|lifecycle_status|moderation_actions \(/);
    }
  });

  it('AC-6: no spec 038 module issues UPDATE bookings or touches payouts tables', () => {
    for (const file of MODERATION) {
      const source = code(file);
      expect(source, rel(file)).not.toMatch(/UPDATE\s+bookings/i);
      expect(source, rel(file)).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+payouts/i);
    }
  });

  it('no API route writes a lifecycle column or imports the lifecycle module', () => {
    const routes = walk(join(ROOT, 'app', 'api')).filter((f) => f.endsWith('route.ts'));
    for (const file of routes) {
      const source = code(file);
      expect(source, rel(file)).not.toMatch(/lifecycle_status\s*=|moderation\/lifecycle/);
    }
  });

  it('standing.ts is a leaf: it imports only @/lib/db and this spec\'s errors', () => {
    const imports = [...code(join(ROOT, 'lib', 'moderation', 'standing.ts')).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./errors', '@/lib/db', 'drizzle-orm'].sort());
  });

  it('X-1…X-6 enforcement points import the leaf standing module, never the moderation barrel', () => {
    const points = [
      'lib/auth/require-session.ts',
      'lib/requests/create.ts',
      'lib/offers/create.ts',
      'lib/offers/decide.ts',
      'lib/negotiation/revise.ts',
      'lib/negotiation/change-requests.ts',
      'lib/bookings/create.ts',
      'lib/privacy/deletion.ts',
    ];
    for (const point of points) {
      const source = code(join(ROOT, point));
      expect(source, point).toMatch(/from '@\/lib\/moderation\/standing'/);
      expect(source, point).not.toMatch(/from '@\/lib\/moderation'/);
    }
  });

  it('emergency bypass is never requested (§7)', () => {
    for (const file of MODERATION) expect(code(file), rel(file)).not.toMatch(/emergencyBypass\s*:/);
  });
});
