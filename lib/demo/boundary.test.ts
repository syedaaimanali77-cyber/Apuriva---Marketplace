import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flagDefinition, FEATURE_FLAG_REGISTRY } from '@/lib/feature-flags/registry';

/**
 * Spec 045 §6 "Boundary" — source-level guards, the idiom of spec 021's `no-fabricated-success.test.ts`.
 *   - No demo branch exists in any payment, payout, notification or AI module (AC-4, AC-6, D-4).
 *   - No migration inserts a demo row (§4: "Nothing demo is ever inserted by a migration").
 *   - `demo-mode` is registered exactly per §3.7.
 *   - The production sandbox refusals the hosted demo depends on (DEP-1) are still in place, unweakened.
 *   - The provisioner never deletes, and only updates rows it inserted (AC-5).
 */
const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/test-support\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Code only — comments stripped, so a file may describe the boundary it keeps. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');

describe('spec 045 boundaries', () => {
  it.each(['payments', 'payouts', 'notifications', 'ai'])('lib/%s has no is_demo / demo reference', (domain) => {
    const offenders = sourceFiles(join(ROOT, 'lib', domain))
      .filter((file) => /is_demo|isDemo|\bdemo\b|lib\/demo/i.test(code(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no migration inserts a demo row or a demo user', () => {
    const offenders = readdirSync(join(ROOT, 'drizzle'))
      .filter((name) => name.endsWith('.sql'))
      .filter((name) => {
        const text = readFileSync(join(ROOT, 'drizzle', name), 'utf8');
        return /INSERT INTO\s+"?users"?/i.test(text) || /is_demo"?\s*,?[^;]*\btrue\b/i.test(text.replace(/DEFAULT false/gi, ''));
      });
    expect(offenders).toEqual([]);
  });

  it('demo-mode is registered exactly per §3.7: developer, not client-readable, not a kill switch, off everywhere, DEMO_MODE_ENABLED', () => {
    const flag = flagDefinition('demo-mode');
    expect(flag).toMatchObject({
      owningSpec: '045',
      controlledBy: 'developer',
      isKillSwitch: false,
      clientReadable: false,
      overrideVar: 'DEMO_MODE_ENABLED',
      defaults: { development: false, staging: false, production: false },
    });
    expect(flag.description).toBe(
      'Enables one-click demo logins and the demo banner. Only effective outside production on a `_demo` database (spec 045).',
    );
    expect(FEATURE_FLAG_REGISTRY.filter((f) => f.key === 'demo-mode')).toHaveLength(1);
  });

  it('DEP-1 is not worked around: every adapter factory still refuses its sandbox under NODE_ENV=production', () => {
    const factories = [
      'lib/payments/provider/index.ts',
      'lib/payments/provider/payout-factory.ts',
      'lib/notifications/channels/index.ts',
      'lib/ai/provider/index.ts',
    ];
    for (const file of factories) {
      expect(code(join(ROOT, file)), file).toMatch(/NODE_ENV === 'production'/);
    }
    for (const file of sourceFiles(join(ROOT, 'lib', 'demo'))) {
      expect(code(file), rel(file)).not.toMatch(/NODE_ENV\s*=/);
      expect(code(file), rel(file)).not.toMatch(/process\.env\.(PAYMENT|PAYOUT|NOTIFICATION_CHANNEL|AI)_PROVIDER\s*=/);
    }
  });

  it('the provisioner never deletes and never updates a row it did not insert (AC-5)', () => {
    for (const file of sourceFiles(join(ROOT, 'lib', 'demo'))) {
      const source = code(file);
      expect(source, rel(file)).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(source, rel(file)).not.toMatch(/\bTRUNCATE\b/i);
    }
    // The only UPDATE the seed issues itself is the trigger walk, always keyed on the id of a row it inserted.
    const writers = code(join(ROOT, 'lib', 'demo', 'seed', 'writers.ts'));
    expect(writers.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(writers).toMatch(/UPDATE \$\{sql\.raw\(table\)\}[\s\S]{0,200}WHERE id = \$\{id\} AND status = \$\{current\}/);
  });

  it('no demo route or page imports a payment, payout or notification module directly', () => {
    const files = [
      ...sourceFiles(join(ROOT, 'app', 'api', 'v1', 'demo')),
      join(ROOT, 'app', '(auth)', 'demo', 'page.tsx'),
      join(ROOT, 'app', '_components', 'DemoModeBanner.tsx'),
    ];
    for (const file of files) {
      expect(code(file), rel(file)).not.toMatch(/from '@\/lib\/(payments|payouts|notifications)/);
    }
  });
});
