import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 029 §3 — SOURCE-LEVEL guards, so this spec's three hardest invariants cannot rot as it
 * grows. The same technique `lib/bookings/payment-boundary.test.ts` and
 * `lib/files/boundaries.test.ts` already use.
 *
 * The invariants asserted here are exactly the ones §3 states:
 *
 *   1. AC-4/AC-8 — ONLY `moderation.ts` can write `status = 'removed'`. A heuristic, a report, a
 *      report count or a future helper must be structurally unable to hide a review. The database's
 *      `reviews_removal_pairing_ck` is the other half of this guarantee; between them, removal is
 *      impossible without a named human and a recorded reason.
 *   2. AC-1 — `lib/reviews/**` reads no payment state and imports no payment module, so review
 *      eligibility can never come to depend on whether money moved (spec 020 §3's boundary rule,
 *      applied to this spec).
 *   3. Spec 033 — no module here reaches past `@/lib/ai` into `lib/ai/provider/**`, the vendor
 *      boundary spec 033 owns. Today nothing imports `@/lib/ai` at all, because MVP flagging is
 *      rule-based; this guard is what keeps a later AI-assisted signal honest.
 */
const ROOT = join(__dirname, '..', '..');
const DOMAIN_DIR = join(ROOT, 'lib', 'reviews');
const ROUTE_DIRS = [
  join(ROOT, 'app', 'api', 'v1', 'reviews'),
  join(ROOT, 'app', 'api', 'v1', 'admin', 'reviews'),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const DOMAIN_FILES = sourceFiles(DOMAIN_DIR).filter((f) => !/\.test\.tsx?$|-test-support\.ts$/.test(f));
const ROUTE_FILES = ROUTE_DIRS.flatMap(sourceFiles);
const ALL_FILES = [...DOMAIN_FILES, ...ROUTE_FILES];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Strips line and block comments, so prose about `'removed'` is not mistaken for code. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('spec 029 source boundaries', () => {
  it('has files to check (a broken glob would make every assertion below vacuous)', () => {
    expect(DOMAIN_FILES.length).toBeGreaterThan(10);
    expect(ROUTE_FILES.length).toBeGreaterThan(2);
  });

  describe("AC-4/AC-8: only moderation.ts can produce 'removed'", () => {
    /**
     * A WRITE position is what matters. Reads — `status === 'removed'`, `status <> 'removed'`,
     * `'removed'` in a type union — are how the rest of the spec RESPECTS a removal, and are fine.
     * What must not exist anywhere else is an assignment or an INSERT/UPDATE that sets it.
     */
    const WRITE_PATTERNS = [
      /status\s*=\s*'removed'/,
      /SET\s+status\s*=\s*'removed'/i,
      /status:\s*'removed'/,
    ];

    it('no module other than moderation.ts writes it', () => {
      const offenders = ALL_FILES.filter((file) => {
        if (file.endsWith(join('lib', 'reviews', 'moderation.ts'))) return false;
        const body = code(file);
        return WRITE_PATTERNS.some((pattern) => pattern.test(body));
      });
      expect(offenders).toEqual([]);
    });

    it('moderation.ts does write it, so the guard above is not passing vacuously', () => {
      expect(WRITE_PATTERNS.some((p) => p.test(code(join(DOMAIN_DIR, 'moderation.ts'))))).toBe(true);
    });

    it('the one removal path stamps a reason, an admin and an instant together', () => {
      // These three are what `reviews_removal_pairing_ck` requires; writing one without the others
      // would fail at the database, and this catches it at the source instead.
      const body = code(join(DOMAIN_DIR, 'moderation.ts'));
      expect(body).toMatch(/removal_reason/);
      expect(body).toMatch(/moderated_by_admin_id/);
      expect(body).toMatch(/moderated_at/);
    });

    it('the signal evaluator cannot reach a status at all', () => {
      const body = code(join(DOMAIN_DIR, 'signals.ts'));
      expect(body).not.toMatch(/'removed'|'flagged'|'published'/);
      // Pure: no database handle, no query, no logging.
      expect(body).not.toMatch(/getDb|queryRows|console\./);
    });

    it('the report path never narrows visibility', () => {
      const body = code(join(DOMAIN_DIR, 'report.ts'));
      expect(body).not.toMatch(/status\s*=\s*'removed'/);
      // The only status write it performs is the widening published -> flagged.
      const writes = body.match(/SET status = '\w+'/g) ?? [];
      expect(writes).toEqual(["SET status = 'flagged'"]);
    });
  });

  describe('AC-1: the payment boundary', () => {
    it('imports no payment or refund module', () => {
      const offenders = ALL_FILES.filter((file) =>
        /from\s+'@\/lib\/(payments|refunds|payouts)/.test(code(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('reads no payment table', () => {
      const offenders = ALL_FILES.filter((file) =>
        /\b(FROM|JOIN|UPDATE|INTO)\s+(payments|refunds|payouts|price_adjustments)\b/i.test(code(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('reads no protection state', () => {
      const offenders = ALL_FILES.filter((file) => /protection_state|protection_window/i.test(code(file)));
      expect(offenders).toEqual([]);
    });
  });

  describe('spec 033: the AI vendor boundary', () => {
    it('no module reaches into lib/ai/provider', () => {
      const offenders = ALL_FILES.filter((file) => /@\/lib\/ai\/provider/.test(code(file)));
      expect(offenders).toEqual([]);
    });

    it('MVP flagging makes no AI call at all', () => {
      const offenders = ALL_FILES.filter((file) => /completeAi\s*\(/.test(code(file)));
      expect(offenders).toEqual([]);
    });
  });

  describe('spec 017: the ranking boundary', () => {
    it('this spec computes no score, weight or ranking', () => {
      const offenders = ALL_FILES.filter((file) => /scoreProvider|rankCandidates|MatchingWeights/.test(code(file)));
      expect(offenders).toEqual([]);
    });

    it('it reaches spec 017 only through the registered port', () => {
      const importers = ALL_FILES.filter((file) => /@\/lib\/matching/.test(code(file)));
      for (const file of importers) {
        expect(code(file)).toMatch(/@\/lib\/matching\/rating-source/);
      }
    });
  });

  describe('spec 027: the storage boundary', () => {
    it('this spec creates no second storage path', () => {
      const offenders = ALL_FILES.filter((file) =>
        /FileAssetStorage|resolveFileStorageAdapter|storage_key/.test(code(file)),
      );
      expect(offenders).toEqual([]);
    });

    it('its context policy lives in this spec, not inside lib/files', () => {
      // Spec 027 §3 makes the consuming spec the owner of "who may see a file in this context",
      // and `lib/files/boundaries.test.ts` enforces that lib/files never acquires one.
      expect(read(join(DOMAIN_DIR, 'media-policy.ts'))).toMatch(/registerFileContextPolicy/);
    });
  });
});
