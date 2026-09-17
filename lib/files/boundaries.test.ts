import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 027 §6 "Source guard" — this spec provides a PRIMITIVE; it must never acquire a consuming
 * spec's business rules. Asserted on CODE, comments stripped (the spec 021/024/026 guard idiom).
 */
const ROOT = join(__dirname, '..', '..');
const FILES_DIR = join(ROOT, 'lib', 'files');
const ROUTES_DIR = join(ROOT, 'app', 'api', 'v1', 'files');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isProduction = (file: string) => !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(FILES_DIR).filter(isProduction);
const ROUTES = sourceFiles(ROUTES_DIR).filter(isProduction);

/**
 * The ONLY non-files `@/lib` modules this domain may import: shared infrastructure, spec 008's
 * storage PORT, and the READ-ONLY authorization helpers its shipped context policies delegate to.
 * Each of the last group is another spec's existing rule being REUSED, never re-implemented here.
 */
const ALLOWED_IMPORTS = new Set([
  '@/lib/db',
  '@/lib/api/errors',
  '@/lib/auth/secret',
  '@/lib/auth/session',
  '@/lib/types/files',
  '@/lib/types/users',
  // Spec 008's storage port — implemented, never modified.
  '@/lib/privacy/file-asset-storage',
  // Spec 025's participant rule, reused not re-implemented.
  '@/lib/messaging/conversations',
  // Spec 009's permission resolution + audit helper, for the audited admin read path.
  '@/lib/admin-rbac/audit',
  '@/lib/admin-rbac/permissions',
]);

describe('files source guard (spec 027 §6)', () => {
  it('imports only infrastructure, spec 008s port and read-only authorization helpers', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of code(file).matchAll(/from\s+'(@\/[^']+)'/g)) {
        const target = match[1]!;
        if (target.startsWith('@/lib/files')) continue;
        if (!ALLOWED_IMPORTS.has(target)) offenders.push(`${relative(ROOT, file)} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes no consumer table — every consuming spec owns its own rows', () => {
    const forbidden =
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(requests|bookings|messages|conversations|payments|refunds|payouts|offers|users|request_attachments|message_attachments|provider_profiles|customer_profiles)"?\b/i;
    const offenders = FILES.filter((file) => forbidden.test(code(file))).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('no route sets status, visibility, owner, context or storageKey from a request body', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(4);
    for (const route of ROUTES) {
      const source = code(route);
      // A route may READ an asset's derived fields, but must never assign one from input.
      for (const forbidden of [
        /body\.(status|visibility|storageKey|storage_key|uploadedByUserId|contextType)\b/,
        /status\s*[:=]\s*(body|input|payload|parsed)\./,
        /visibility\s*[:=]\s*(body|input|payload|parsed)\./,
        /\bUPDATE\s+file_assets\b/i,
        /\bINSERT\s+INTO\s+file_assets\b/i,
      ]) {
        expect(source, `${relative(ROOT, route)} :: ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('only the upload path inserts a file_assets row, and only server-derived values reach it', () => {
    const inserters = FILES.filter((file) => /\bINSERT\s+INTO\s+file_assets\b/i.test(code(file)));
    expect(inserters.map((f) => relative(ROOT, f).replace(/\\/g, '/'))).toEqual(['lib/files/upload.ts']);
  });

  it('never logs a file name, storage key, signature or byte content', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of code(file).matchAll(/console\.(log|error|warn)\(([\s\S]*?)\);/g)) {
        const args = match[2]!;
        if (/\b(fileName|file_name|storageKey|storage_key|signature|sig|bytes|content)\s*[:,}]/.test(args)) {
          offenders.push(`${relative(ROOT, file)}: ${args.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no consuming-spec business rule leaks in — no reference to a consumer domain module', () => {
    const forbidden = /@\/lib\/(requests|bookings|offers|payments|refunds|payouts|negotiation|matching|notifications)\b/;
    const offenders: string[] = [];
    for (const file of FILES) {
      if (forbidden.test(code(file))) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('every mutating route requires CSRF, and every browser route requires a session', () => {
    for (const route of ROUTES) {
      const source = code(route);
      const relPath = relative(ROOT, route).replace(/\\/g, '/');
      // The content route is signature-authenticated by design (it is the signed-URL target).
      if (relPath.endsWith('content/route.ts')) {
        expect(source, relPath).toMatch(/verify(Content|Upload)Signature/);
        continue;
      }
      expect(source, relPath).toMatch(/requireSession\(/);
      if (/export const (POST|PUT|PATCH|DELETE)/.test(source)) {
        expect(source, relPath).toMatch(/requireCsrf\(/);
      }
    }
  });
});
