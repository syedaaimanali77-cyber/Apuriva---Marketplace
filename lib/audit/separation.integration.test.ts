import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { registerAdmin, grantRole } from '@/app/api/v1/admin/admin-rbac-test-support';
import { isDatabaseReachable, uniqueTag } from './audit-test-support';

const dbReachable = await isDatabaseReachable();

async function countIn(table: 'audit_logs' | 'security_events', eventType: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE event_type = ${eventType}`,
  );
  return row!.n;
}

/**
 * Spec 039 AC-3 / §3.4 — the audit log is its own store. Admin audit events go ONLY to `audit_logs`
 * (D-1, no dual write); spec 005's security events stay ONLY in `security_events`.
 */
describe.skipIf(!dbReachable)('audit log separation (spec 039 AC-3)', { timeout: 60_000 }, () => {
  it('an admin audit event is written to audit_logs and NOT to security_events', async () => {
    const admin = await registerAdmin();
    await grantRole(admin, 'content_admin');
    const eventType = uniqueTag('catalog.spec039_sep');
    await recordAdminAuditEvent({
      actorUserId: admin.userId,
      actorRoles: ['content_admin'],
      eventType,
      resource: 'catalog.category',
      action: 'create',
      approvalChain: [],
    });
    expect(await countIn('audit_logs', eventType)).toBe(1);
    expect(await countIn('security_events', eventType)).toBe(0);
  });

  it('a security event (auth/privacy) stays in security_events and never reaches audit_logs', async () => {
    const admin = await registerAdmin();
    const eventType = uniqueTag('auth.spec039_sep');
    await recordSecurityEvent({ userId: admin.userId, eventType, severity: 'info', metadata: { ip: 'x' } });
    expect(await countIn('security_events', eventType)).toBe(1);
    expect(await countIn('audit_logs', eventType)).toBe(0);
  });

  it('the two stores are structurally distinct tables', async () => {
    const columns = await queryRows<{ table_name: string; column_name: string }>(
      getDb(),
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name IN ('audit_logs', 'security_events')`,
    );
    const of = (table: string) => new Set(columns.filter((c) => c.table_name === table).map((c) => c.column_name));
    expect(of('audit_logs').has('approval_ref')).toBe(true);
    expect(of('audit_logs').has('correlation_id')).toBe(true);
    expect(of('audit_logs').has('metadata')).toBe(false);
    expect(of('security_events').has('severity')).toBe(true);
    expect(of('security_events').has('approval_ref')).toBe(false);
  });
});
