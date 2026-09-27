import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Spec 041 AC-3 / §3.9 — every applied change writes exactly one spec 039 audit row, right after the
 * commit, through spec 009's one write path; a refused, invalid or no-op request writes none; a failed
 * audit write is never swallowed. Worker runs as `staging` with `search-nl-interpretation` (business)
 * and `ai-fraud-signals` (developer).
 */
const control = vi.hoisted(() => ({ failAudit: false }));

vi.mock('@/lib/admin-rbac/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-rbac/audit')>();
  return {
    ...actual,
    recordAdminAuditEvent: async (input: Parameters<typeof actual.recordAdminAuditEvent>[0]) => {
      if (control.failAudit) throw new Error('audit store unavailable (test)');
      return actual.recordAdminAuditEvent(input);
    },
  };
});

const { sql } = await import('drizzle-orm');
const { getDb } = await import('@/lib/db');
const { queryRows } = await import('@/lib/offers/db');
const { adminWithRole } = await import('@/lib/admin-dashboard/admin-dashboard-test-support');
const { toggleFeatureFlag } = await import('./admin');
const { isDatabaseReachable, restoreStoredFlags, storedFlag, useFlagEnvironment } = await import('./feature-flags-test-support');

const dbReachable = await isDatabaseReachable();
const BUSINESS = 'search-nl-interpretation';
const TECHNICAL = 'ai-fraud-signals';

interface AuditRow {
  actor_user_id: string;
  actor_type: string;
  actor_roles: string[];
  event_type: string;
  resource: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  before_value: unknown;
  after_value: unknown;
  approval_chain: unknown;
}

async function auditRowsWithReason(reason: string): Promise<AuditRow[]> {
  return queryRows<AuditRow>(
    getDb(),
    sql`SELECT actor_user_id, actor_type, actor_roles, event_type, resource, action, target_type, target_id, reason,
               before_value, after_value, approval_chain
          FROM audit_logs WHERE reason = ${reason}`,
  );
}

describe.skipIf(!dbReachable)('flag-change audit (spec 041 AC-3)', { timeout: 120_000 }, () => {
  useFlagEnvironment('staging');
  restoreStoredFlags([
    [BUSINESS, 'staging'],
    [TECHNICAL, 'staging'],
  ]);
  let content: Awaited<ReturnType<typeof adminWithRole>>;
  let superAdmin: Awaited<ReturnType<typeof adminWithRole>>;

  beforeAll(async () => {
    content = await adminWithRole('content_admin');
    superAdmin = await adminWithRole('super_admin');
  }, 120_000);

  it('a business change writes exactly one row: actor, roles, key, environment, before/after, reason', async () => {
    const reason = `ac3-business-${randomUUID()}`;
    const start = await storedFlag(BUSINESS, 'staging');
    await toggleFeatureFlag(content.userId, BUSINESS, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version, reason });
    const rows = await auditRowsWithReason(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      actor_user_id: content.userId,
      actor_type: 'admin',
      actor_roles: ['content_admin'],
      event_type: 'feature_flag.toggled',
      resource: 'feature_flags',
      action: 'toggle',
      target_type: 'feature_flag',
      target_id: BUSINESS,
      reason,
      before_value: { environment: 'staging', enabled: start.enabled },
      after_value: { environment: 'staging', enabled: !start.enabled },
      approval_chain: [],
    });
  });

  it('a developer-flag change is audited under the Super-Admin-only resource', async () => {
    const reason = `ac3-technical-${randomUUID()}`;
    const start = await storedFlag(TECHNICAL, 'staging');
    await toggleFeatureFlag(superAdmin.userId, TECHNICAL, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version, reason });
    const rows = await auditRowsWithReason(reason);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resource: 'feature_flags.technical', action: 'toggle_technical', target_id: TECHNICAL, actor_roles: ['super_admin'] });
  });

  it('a refused, invalid, stale or no-op request writes no row', async () => {
    const start = await storedFlag(BUSINESS, 'staging');
    const refused = `ac3-refused-${randomUUID()}`;
    const technical = await storedFlag(TECHNICAL, 'staging');
    await expect(
      toggleFeatureFlag(content.userId, TECHNICAL, { environment: 'staging', enabled: !technical.enabled, expectedVersion: technical.version, reason: refused }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const noop = `ac3-noop-${randomUUID()}`;
    await toggleFeatureFlag(content.userId, BUSINESS, { environment: 'staging', enabled: start.enabled, expectedVersion: start.version, reason: noop });
    const stale = `ac3-stale-${randomUUID()}`;
    await expect(
      toggleFeatureFlag(content.userId, BUSINESS, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version + 50, reason: stale }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const mismatch = `ac3-env-${randomUUID()}`;
    await expect(
      toggleFeatureFlag(content.userId, BUSINESS, { environment: 'production', enabled: !start.enabled, expectedVersion: start.version, reason: mismatch }),
    ).rejects.toMatchObject({ code: 'FLAG_ENVIRONMENT_MISMATCH' });
    await expect(toggleFeatureFlag(content.userId, BUSINESS, { environment: 'staging', enabled: 'yes', expectedVersion: start.version, reason: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    for (const reason of [refused, noop, stale, mismatch]) expect(await auditRowsWithReason(reason), reason).toEqual([]);
    expect(await storedFlag(BUSINESS, 'staging')).toEqual(start);
  });

  it('a failed audit write is not swallowed: the request fails, and the committed change stands', async () => {
    const reason = `ac3-failed-${randomUUID()}`;
    const start = await storedFlag(BUSINESS, 'staging');
    control.failAudit = true;
    try {
      await expect(
        toggleFeatureFlag(content.userId, BUSINESS, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version, reason }),
      ).rejects.toThrow('audit store unavailable (test)');
    } finally {
      control.failAudit = false;
    }
    expect(await storedFlag(BUSINESS, 'staging')).toEqual({ enabled: !start.enabled, version: start.version + 1 });
    expect(await auditRowsWithReason(reason)).toEqual([]);
  });
});
