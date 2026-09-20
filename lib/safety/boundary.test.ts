/**
 * Spec 030 §6 "Boundary" — source-level assertions that survive future edits.
 *
 * These are the guarantees that cannot be expressed as a runtime test, because what they assert is
 * the ABSENCE of a capability. A behavioural test can only show that the code does not restrict an
 * account today; these show it has no way to.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SAFETY_DIR = join(process.cwd(), 'lib', 'safety');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    // Test scaffolding is excluded: `*-test-support.ts` is a fixture helper, and these
    // assertions are about what the PRODUCTION modules can do. A fixture that READS
    // `users.lifecycle_status` to assert it was left alone is evidence for the boundary, not
    // a breach of it.
    const isSource = full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('-test-support.ts');
    return isSource ? [full] : [];
  });
}

/**
 * Comments are stripped before every scan below. These assertions are about what the CODE can do,
 * not about what the prose says — and this spec's files talk about `users.lifecycle_status` and
 * `user_restrictions` at length precisely to explain why they never touch them. Scanning raw text
 * would make a file fail for documenting its own boundary, which is exactly backwards.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(SAFETY_DIR).map((path) => ({
  path,
  source: stripComments(readFileSync(path, 'utf8')),
}));

describe('spec 030 source boundaries', () => {
  it('has files to check (a broken glob would make every assertion below vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(8);
  });

  describe('DECIDED-3: spec 030 owns no enforcement action', () => {
    it('no module writes users.lifecycle_status', () => {
      const offenders = FILES.filter((f) => /lifecycle_status|lifecycleStatus/.test(f.source));
      expect(offenders.map((f) => f.path)).toEqual([]);
    });

    it('no module references the restricted, suspended or banned account states', () => {
      // Deliberately a source scan, not a behavioural test: the point is that the vocabulary of
      // account sanctions does not appear in this spec at all.
      const offenders = FILES.filter(
        (f) => /['"`](restricted|suspended|banned)['"`]/.test(f.source) && !f.path.endsWith('restriction-gate.ts'),
      );
      expect(offenders.map((f) => f.path)).toEqual([]);
    });

    it('defines no user_restrictions permission', () => {
      const offenders = FILES.filter((f) => /user_restrictions/.test(f.source));
      expect(offenders.map((f) => f.path)).toEqual([]);
    });

    it('reaches restriction only through the gate, which this spec never registers', () => {
      const index = FILES.find((f) => f.path.endsWith('index.ts'))!;
      // It EXPORTS the registrar so spec 038 can call it...
      expect(index.source).toContain('registerSafetyRestrictionGate');
      // ...but never calls it itself inside `registerSafetyIntegration`.
      const registration = index.source.slice(index.source.indexOf('export function registerSafetyIntegration'));
      expect(registration).not.toContain('registerSafetyRestrictionGate(');
    });

    it('the gate default throws rather than silently succeeding, so no outcome is fabricated', () => {
      const gate = FILES.find((f) => f.path.endsWith('restriction-gate.ts'))!;
      expect(gate.source).toContain('throw restrictionUnavailableError()');
    });
  });

  describe('spec 033: the AI vendor boundary (AC-4)', () => {
    it('no module reaches into lib/ai/provider', () => {
      const offenders = FILES.filter((f) => /lib\/ai\/provider/.test(f.source));
      expect(offenders.map((f) => f.path)).toEqual([]);
    });

    it('AI is consumed only through the published @/lib/ai surface', () => {
      const importers = FILES.filter((f) => /from '@\/lib\/ai/.test(f.source));
      expect(importers.map((f) => f.path.split(/[\\/]/).pop())).toEqual(['ai-assist.ts']);
      expect(importers[0]!.source).toContain("from '@/lib/ai'");
    });

    it('the AI module has no database access, so it cannot reach a status or a decision', () => {
      const ai = FILES.find((f) => f.path.endsWith('ai-assist.ts'))!;
      expect(ai.source).not.toContain('getDb');
      expect(ai.source).not.toContain('drizzle-orm');
      expect(ai.source).not.toContain('safety_reports');
    });
  });

  describe('DECIDED-1: no automated priority classification', () => {
    it('the report module never branches on a category', () => {
      const reports = FILES.find((f) => f.path.endsWith('reports.ts'))!;
      // A category-to-priority rule would have to read the category to pick a value. It does not:
      // the only use of `input.category` is to store it verbatim.
      expect(reports.source).not.toMatch(/switch\s*\(\s*\w*\.?category/);
      expect(reports.source).not.toMatch(/category\s*===\s*['"]/);
    });

    it('creates every report at one constant priority', () => {
      const reports = FILES.find((f) => f.path.endsWith('reports.ts'))!;
      expect(reports.source).toContain('DEFAULT_SAFETY_PRIORITY');
    });
  });

  describe('spec 017: the matching boundary', () => {
    it('lib/matching never imports lib/safety, so the dependency stays one-directional', () => {
      const matchingDir = join(process.cwd(), 'lib', 'matching');
      const offenders = sourceFiles(matchingDir).filter((p) => /@\/lib\/safety/.test(stripComments(readFileSync(p, 'utf8'))));
      expect(offenders).toEqual([]);
    });
  });

  describe('spec 027: the storage boundary', () => {
    it('this spec creates no second storage path', () => {
      const offenders = FILES.filter((f) => /storage_key|resolveFileStorageAdapter/.test(f.source));
      expect(offenders.map((f) => f.path)).toEqual([]);
    });

    it('its context policy lives in this spec, not inside lib/files', () => {
      const filesDir = join(process.cwd(), 'lib', 'files');
      const offenders = sourceFiles(filesDir).filter((p) => /safety_evidence/.test(stripComments(readFileSync(p, 'utf8'))));
      expect(offenders).toEqual([]);
    });
  });
});
