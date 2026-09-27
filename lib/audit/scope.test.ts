import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec 039 §3.7 (AC-4) — the scope map and its resolution. Role/permission reads are mocked here so
 * every branch is exercised deterministically; `access.integration.test.ts` covers the live matrix.
 */
const state: { roles: string[]; held: { resource: string; action: string }[] } = { roles: [], held: [] };

vi.mock('@/lib/admin-rbac/permissions', () => ({
  getAdminRoleNames: async () => state.roles,
}));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => state.held }) }) }),
  }),
}));

const { AUDIT_RESOURCE_READ_PERMISSION, isResourceInScope, resolveAuditScope } = await import('./scope');

const ROOT = join(__dirname, '..', '..');
const READ = { resource: 'audit_logs', action: 'read' };

beforeEach(() => {
  state.roles = [];
  state.held = [];
});

describe('audit scope resolution (spec 039 §3.7)', () => {
  it('a non-admin is refused 403', async () => {
    await expect(resolveAuditScope('u')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin without audit_logs/read is refused 403', async () => {
    state.roles = ['finance_admin'];
    state.held = [{ resource: 'payouts', action: 'read' }];
    await expect(resolveAuditScope('u')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('super_admin sees everything', async () => {
    state.roles = ['super_admin'];
    state.held = [READ];
    const scope = await resolveAuditScope('u');
    expect(scope).toEqual({ all: true, resources: [] });
    expect(isResourceInScope(scope, 'admin_rbac.role')).toBe(true);
    expect(isResourceInScope(scope, 'anything.new')).toBe(true);
  });

  it('a domain role sees only resources whose READ-LEVEL permission it holds', async () => {
    state.roles = ['finance_admin'];
    state.held = [READ, { resource: 'payouts', action: 'read' }, { resource: 'refunds', action: 'read' }, { resource: 'moderation', action: 'freeze_payout' }];
    const scope = await resolveAuditScope('u');
    expect(scope).toEqual({ all: false, resources: ['payouts', 'refunds'] });
    // Holding moderation/freeze_payout is NOT moderation/read (spec 038 least privilege).
    expect(isResourceInScope(scope, 'moderation')).toBe(false);
  });

  it('catalog FAQ and field entries follow catalog.service/view', async () => {
    state.roles = ['content_admin'];
    state.held = [READ, { resource: 'catalog.service', action: 'view' }];
    const scope = await resolveAuditScope('u');
    expect(scope.resources).toEqual(['catalog.service', 'catalog.service_faq', 'catalog.service_field']);
  });

  it('a role mapping to nothing gets an empty scope, not an error', async () => {
    state.roles = ['analytics_admin'];
    state.held = [READ, { resource: 'ai', action: 'read_usage' }];
    expect(await resolveAuditScope('u')).toEqual({ all: false, resources: [] });
  });

  it('default deny: role-change, MCP and unmapped entries are super_admin only', () => {
    const scope = { all: false, resources: Object.keys(AUDIT_RESOURCE_READ_PERMISSION) };
    for (const resource of ['admin_rbac.role', 'mcp', 'some.future_resource']) {
      expect(isResourceInScope(scope, resource)).toBe(false);
    }
  });
});

describe('the scope map itself (spec 039 §3.7)', () => {
  it('is exactly the §3.7 table', () => {
    expect(Object.keys(AUDIT_RESOURCE_READ_PERMISSION).sort()).toEqual(
      [
        'cancellation_policy',
        'catalog.category',
        'catalog.service',
        'catalog.service_faq',
        'catalog.service_field',
        'catalog.subcategory',
        'catalog.suggestion',
        'disputes',
        'feature_flags',
        'feature_flags.technical',
        'fraud_signal',
        'matching.config',
        'messaging',
        'moderation',
        'no_show_reports',
        'payouts',
        'refunds',
        'reviews',
        'safety_reports',
        'support',
      ].sort(),
    );
  });

  it('every required read permission is actually seeded by a migration', () => {
    const migrations = readdirSync(join(ROOT, 'drizzle'))
      .filter((file) => file.endsWith('.sql') && !file.endsWith('_down.sql'))
      .map((file) => readFileSync(join(ROOT, 'drizzle', file), 'utf8'))
      .join('\n');
    for (const { resource, action } of Object.values(AUDIT_RESOURCE_READ_PERMISSION)) {
      expect(migrations, `${resource}/${action}`).toMatch(new RegExp(`'${resource.replace('.', '\\.')}',\\s*'${action}'`));
    }
  });

  it('every resource production code audits is mapped, or deliberately super_admin only (R-3)', () => {
    const SUPER_ADMIN_ONLY = ['admin_rbac.role', 'mcp'];
    const sources = productionSources();
    const constants = new Map<string, string>();
    for (const file of sources) {
      for (const match of readFileSync(file, 'utf8').matchAll(/export const ([A-Z_]+)\s*=\s*'([a-z_.]+)'/g)) {
        constants.set(match[1]!, match[2]!);
      }
    }
    const audited = new Set<string>();
    for (const file of sources) {
      const code = readFileSync(file, 'utf8');
      if (!/recordAdminAuditEvent\(|authorizeAndInitiate\(|auditModeration\(|writeAuditEntry\(/.test(code)) continue;
      for (const match of code.matchAll(/\bresource:\s*('([a-z_.]+)'|([A-Z_]+))/g)) {
        const value = match[2] ?? constants.get(match[3]!);
        if (value) audited.add(value);
      }
    }
    // Spec 038 derives its resource from the event-type prefix.
    audited.add('moderation');
    audited.add('fraud_signal');
    const unmapped = [...audited].filter((r) => !(r in AUDIT_RESOURCE_READ_PERMISSION) && !SUPER_ADMIN_ONLY.includes(r));
    expect(unmapped.map((r) => r)).toEqual([]);
    expect(audited.size).toBeGreaterThan(10);
  });
});

function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-support|\.d\.ts$/.test(name)) out.push(path);
    }
  };
  walk(join(ROOT, 'lib'));
  walk(join(ROOT, 'app', 'api'));
  return out.filter((file) => !relative(ROOT, file).startsWith(join('lib', 'audit', 'scope')));
}
