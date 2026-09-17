import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 026 §6 "Source guard" — delivery must not acquire business logic, and no client can create a
 * notification. Asserted on CODE, comments stripped (the spec 021/024 guard idiom).
 */
const ROOT = join(__dirname, '..', '..');
const NOTIFICATIONS_DIR = join(ROOT, 'lib', 'notifications');

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

const FILES = sourceFiles(NOTIFICATIONS_DIR).filter(isProduction);

/** The ONLY non-notification `@/lib` modules this domain may import: shared infrastructure and the four PORTS. */
const ALLOWED_IMPORTS = new Set([
  '@/lib/db',
  '@/lib/api/errors',
  '@/lib/api/pagination',
  '@/lib/auth/security-event',
  '@/lib/types/notifications',
  '@/lib/refunds/notifications',
  '@/lib/cancellation/notifications',
  '@/lib/messaging/notifications',
  '@/lib/payouts/ports',
]);

describe('notifications source guard (spec 026 §6)', () => {
  it('imports no producing spec domain module — only infrastructure and the notification ports', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of code(file).matchAll(/from\s+'(@\/[^']+)'/g)) {
        const target = match[1]!;
        if (target.startsWith('@/lib/notifications')) continue;
        if (!ALLOWED_IMPORTS.has(target)) offenders.push(`${relative(ROOT, file)} -> ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes no booking, payment, refund, payout or message row', () => {
    const forbidden = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(bookings|payments|refunds|refund_lines|payouts|payout_items|messages|conversations|requests|offers|provider_availability_notification_requests)"?\b/i;
    const offenders = FILES.filter((file) => forbidden.test(code(file))).map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('no route creates a notification', () => {
    const routes = [
      ...sourceFiles(join(ROOT, 'app', 'api', 'v1', 'users', 'me', 'notifications')),
      join(ROOT, 'app', 'api', 'v1', 'users', 'me', 'notification-preferences', 'route.ts'),
      join(ROOT, 'app', 'api', 'v1', 'users', 'me', 'marketing-consent', 'route.ts'),
    ].filter((file) => file.endsWith('route.ts'));
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const route of routes) {
      const source = code(route);
      expect(source, relative(ROOT, route)).not.toMatch(/\bnotify\b/);
      expect(source, relative(ROOT, route)).not.toMatch(/INSERT\s+INTO\s+notifications/i);
    }
    // And nothing else under app/ reaches the creation entry point.
    const appFiles = sourceFiles(join(ROOT, 'app')).filter(isProduction);
    const creators = appFiles.filter((file) => /import\s*\{[^}]*\bnotify\b[^}]*\}\s*from\s*'@\/lib\/notifications/.test(code(file)));
    expect(creators.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('never logs a title, body or params value', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const match of code(file).matchAll(/console\.(log|error)\(([\s\S]*?)\);/g)) {
        if (/\b(title|body|params)\s*[:,}]/.test(match[2]!) || /\brendered\b/.test(match[2]!)) {
          offenders.push(relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
