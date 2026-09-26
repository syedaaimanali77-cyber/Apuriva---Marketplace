import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { queryRows } from '@/lib/offers/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { auditRowsByEventType, isDatabaseReachable, uniqueTag } from './audit-test-support';

const dbReachable = await isDatabaseReachable();

/** The Postgres SQLSTATE a refused write surfaces with, wherever drizzle nests the driver error. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

async function refusal(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
  } catch (err) {
    return sqlState(err);
  }
  return 'NOT_REFUSED';
}

/**
 * Spec 039 AC-2 — append-only at the database, as the application's own role (the single role the
 * app, migrator and tests share, §4). Triggers, not grants: this role owns the table.
 */
describe.skipIf(!dbReachable)('audit_logs is append-only (spec 039 AC-2)', { timeout: 60_000 }, () => {
  async function seedRow(): Promise<{ id: string; eventType: string }> {
    const user = await registerAndLogin();
    const eventType = uniqueTag('spec039.immutable');
    await recordAdminAuditEvent({
      actorUserId: user.userId,
      actorRoles: [],
      eventType,
      resource: 'support',
      action: 'x',
      reason: 'original',
      approvalChain: [],
    });
    const [row] = await auditRowsByEventType(eventType);
    return { id: row!.id, eventType };
  }

  it('UPDATE is refused with 23514 and the row is unchanged', async () => {
    const { id, eventType } = await seedRow();
    expect(await refusal(() => getDb().update(auditLogs).set({ reason: 'tampered' }).where(eq(auditLogs.id, id)))).toBe('23514');
    expect(await refusal(() => getPool().query(`UPDATE audit_logs SET reason = 'tampered' WHERE id = $1`, [id]))).toBe('23514');
    const [row] = await auditRowsByEventType(eventType);
    expect(row).toMatchObject({ reason: 'original', version: 1 });
  });

  it('DELETE is refused with 23514 and the row survives', async () => {
    const { id, eventType } = await seedRow();
    expect(await refusal(() => getDb().delete(auditLogs).where(eq(auditLogs.id, id)))).toBe('23514');
    expect(await refusal(() => getPool().query(`DELETE FROM audit_logs WHERE id = $1`, [id]))).toBe('23514');
    expect(await auditRowsByEventType(eventType)).toHaveLength(1);
  });

  it('TRUNCATE is refused with 23514 and nothing is lost', async () => {
    const { eventType } = await seedRow();
    expect(await refusal(() => getPool().query('TRUNCATE audit_logs'))).toBe('23514');
    expect(await auditRowsByEventType(eventType)).toHaveLength(1);
  });

  it('the refusing triggers are installed for UPDATE, DELETE and TRUNCATE', async () => {
    const rows = await queryRows<{ tgname: string }>(
      getDb(),
      sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual(['audit_logs_append_only_trg', 'audit_logs_no_truncate_trg']);
    const events = await queryRows<{ event_manipulation: string }>(
      getDb(),
      sql`SELECT DISTINCT event_manipulation FROM information_schema.triggers WHERE event_object_table = 'audit_logs'`,
    );
    expect(events.map((e) => e.event_manipulation).sort()).toEqual(['DELETE', 'UPDATE']);
  });
});
