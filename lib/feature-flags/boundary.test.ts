import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 041 boundaries (AC-2, AC-4, D-3, D-7): one writer of the flag tables, no in-process cache,
 * every migrated gate reads the registry, the stand-in functions keep their sync contracts, and the
 * effective endpoint cannot return a developer flag.
 */
const ROOT = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-support\.ts$|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

const PRODUCTION = [...sources(join(ROOT, 'lib')), ...sources(join(ROOT, 'app'))];
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
const code = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const codeOnly = (file: string) =>
  code(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('spec 041 boundaries', () => {
  it('has production sources to check', () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
  });

  it('only lib/feature-flags/admin.ts writes feature_flag_environment_values; nothing writes feature_flags at runtime', () => {
    const valueWriters = PRODUCTION.filter((f) =>
      /UPDATE\s+"?feature_flag_environment_values|INSERT INTO\s+"?feature_flag_environment_values|DELETE\s+FROM\s+"?feature_flag_environment_values|\.(update|insert|delete)\(featureFlagEnvironmentValues\)/i.test(
        readFileSync(f, 'utf8'),
      ),
    ).map(rel);
    expect(valueWriters).toEqual(['lib/feature-flags/admin.ts']);
    const flagWriters = PRODUCTION.filter((f) =>
      /UPDATE\s+"?feature_flags\b|INSERT INTO\s+"?feature_flags\b|DELETE\s+FROM\s+"?feature_flags\b|\.(update|insert|delete)\(featureFlags\)/i.test(readFileSync(f, 'utf8')),
    ).map(rel);
    expect(flagWriters).toEqual([]);
  });

  it('there is no process-local flag cache (D-7): no module-level Map, cache or TTL in lib/feature-flags', () => {
    for (const file of sources(join(ROOT, 'lib/feature-flags')).map(rel)) {
      const source = codeOnly(file);
      expect(source, file).not.toMatch(/^(let|const)\s+\w*(cache|Cache|memo|Memo)\w*\s*=/m);
      expect(source, file).not.toMatch(/\bTTL\b|ttlMs|setInterval|new Map<string,\s*boolean>/);
    }
  });

  it('every migrated gate site awaits isFeatureEnabled with its registry key (X-1…X-5)', () => {
    const gates: Record<string, string[]> = {
      'lib/ai/complete.ts': ['ai-assistant'],
      'app/api/v1/search/interpret/route.ts': ['search-nl-interpretation'],
      'lib/home/feed.ts': ['home-personalization-v1'],
      'lib/ai-assistant/feature-flags.ts': ['ai-conversational-assistant', 'ai-assistant'],
      'lib/moderation/fraud-signals.ts': ['ai-fraud-signals'],
    };
    for (const [file, keys] of Object.entries(gates)) {
      for (const key of keys) expect(code(file), `${file} ${key}`).toContain(`await isFeatureEnabled('${key}')`);
    }
    expect(code('lib/ai/complete.ts')).not.toMatch(/isAiAssistantEnabled\(\)/);
    expect(code('lib/home/feed.ts')).not.toMatch(/isHomePersonalizationEnabled\(\)/);
    expect(code('lib/moderation/fraud-signals.ts')).not.toMatch(/isAiFraudSignalsEnabled\(\)/);
    expect(code('app/api/v1/search/interpret/route.ts')).not.toMatch(/isNlInterpretationEnabled\(\)/);
  });

  it('the stand-in functions keep their synchronous env contracts (D-3)', () => {
    expect(code('lib/ai/feature-flags.ts')).toMatch(/export function isAiAssistantEnabled\(\): boolean/);
    expect(code('lib/home/feature-flags.ts')).toMatch(/export function isHomePersonalizationEnabled\(\): boolean/);
    expect(code('lib/search/feature-flags.ts')).toMatch(/export function isNlInterpretationEnabled\(\): boolean/);
    expect(code('lib/moderation/flags.ts')).toMatch(/export function isAiFraudSignalsEnabled\(\): boolean/);
    expect(code('lib/ai-assistant/feature-flags.ts')).toMatch(/export function isConversationalAssistantEnabled\(\): boolean/);
  });

  it('every awaited Ask Apuriva gate is awaited at its call site (X-4)', () => {
    for (const file of ['lib/ai-assistant/actions.ts', 'lib/ai-assistant/conversations.ts', 'lib/ai-assistant/memory.ts', 'lib/ai-assistant/turns.ts']) {
      expect(code(file), file).toContain('await requireAskApurivaAvailable()');
      expect(codeOnly(file), file).not.toMatch(/[^t]\s+requireAskApurivaAvailable\(\);/);
    }
    expect(code('lib/ai-assistant/suggestions.ts')).toContain('await isAskApurivaAvailable()');
  });

  it('the effective endpoint reads only client-readable business flags (AC-2)', () => {
    const resolve = codeOnly('lib/feature-flags/resolve.ts');
    expect(resolve).toMatch(/WHERE f\.client_readable AND f\.controlled_by = 'business'/);
    expect(codeOnly('app/api/v1/feature-flags/effective/route.ts')).toMatch(/resolveClientFlags\(\)/);
    expect(codeOnly('app/api/v1/feature-flags/effective/route.ts')).not.toMatch(/listFeatureFlags|isFeatureEnabled/);
  });

  it('the browser helper imports nothing server-side', () => {
    expect(code('lib/feature-flags/client.ts')).not.toMatch(/^import /m);
    expect(code('app/_components/OnboardingOverlay.tsx')).toContain("from '@/lib/feature-flags/client'");
  });
});
