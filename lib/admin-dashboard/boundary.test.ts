import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 037 AC-4 / AC-5 / D-3 — a SOURCE-LEVEL guard, the idiom specs 020, 021 and 033 use, so the
 * dashboard's boundary cannot rot: it reads, it never writes, it never reaches a developer-controlled
 * setting, and it never becomes a second writer of the configuration it displays.
 */
const ROOT = join(__dirname, '..', '..');
const MODULE_DIR = join(ROOT, 'lib', 'admin-dashboard');
const ROUTE_FILES = [
  'app/api/v1/admin/overview/route.ts',
  'app/api/v1/admin/operations/queue/route.ts',
  'app/api/v1/admin/marketplace/config/route.ts',
].map((file) => join(ROOT, file));
const PAGE_FILES = ['app/admin/page.tsx', 'app/admin/operations/page.tsx', 'app/admin/marketplace/config/page.tsx'].map((file) =>
  join(ROOT, file),
);

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !/test-support\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Code only — comments are stripped, so documenting the boundary never trips it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SERVER_FILES = [...productionFiles(MODULE_DIR), ...ROUTE_FILES];

describe('spec 037 — the Admin Dashboard boundary', () => {
  it('has the module, routes and pages to check', () => {
    expect(productionFiles(MODULE_DIR).length).toBeGreaterThanOrEqual(5);
  });

  it('DTOs are a closed allow-list and read no environment value (AC-4)', () => {
    for (const file of [...SERVER_FILES, ...PAGE_FILES]) {
      expect(code(file), relative(ROOT, file)).not.toMatch(/process\.env/);
    }
  });

  it('spec 037 performs no write (AC-5, D-3): no INSERT/UPDATE/DELETE and no write import', () => {
    for (const file of SERVER_FILES) {
      const source = code(file);
      const name = relative(ROOT, file);
      expect(source, name).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
      expect(source, name).not.toMatch(/\.(insert|update|delete)\(/);
      expect(source, name).not.toMatch(/\b(updateMatchingWeights|approveMatchingSuggestion|publishCancellationPolicy|recordAdminAuditEvent)\b/);
    }
  });

  it('the three routes export GET only — no duplicate configuration mutation endpoint', () => {
    for (const file of ROUTE_FILES) {
      const source = code(file);
      expect(source.match(/export const (GET|POST|PUT|PATCH|DELETE)\b/g), relative(ROOT, file)).toEqual(['export const GET']);
    }
  });

  it('the pages call only the three dashboard endpoints, with GET, and never a write route', () => {
    for (const file of PAGE_FILES) {
      const source = code(file);
      expect(source, relative(ROOT, file)).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
      for (const url of source.match(/['"`]\/api\/v1\/[^'"`?]*/g) ?? []) {
        expect(['/api/v1/admin/overview', '/api/v1/admin/operations/queue', '/api/v1/admin/marketplace/config']).toContain(url.slice(1));
      }
    }
  });
});
