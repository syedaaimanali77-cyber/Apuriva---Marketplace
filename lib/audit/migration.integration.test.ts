import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { isDatabaseReachable } from './audit-test-support';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0034_implement_audit_log.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0034_implement_audit_log_down.sql'), 'utf8');
const SEVEN_ROLES = ['analytics_admin', 'content_admin', 'finance_admin', 'operations_admin', 'super_admin', 'support_admin', 'trust_safety_admin'];

describe('migration 0034 — file-level guarantees (spec 039 §4)', () => {
  it('is the next journal entry after 0033 and has a hand-written down file', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.indexOf('0034_implement_audit_log')).toBe(tags.indexOf('0033_add_admin_moderation_fraud') + 1);
    expect(DOWN).toMatch(/PRE-LAUNCH ONLY/);
  });

  it('ALTERS the spec 003 stub — never re-creates it — and backfills nothing', () => {
    expect(UP).toMatch(/ALTER TABLE "audit_logs"/);
    expect(UP).not.toMatch(/CREATE TABLE[^;]*audit_logs/);
    expect(UP).not.toMatch(/INSERT INTO "?audit_logs|FROM\s+"?security_events/);
  });

  it('adds the append-only triggers for UPDATE, DELETE and TRUNCATE, raising 23514', () => {
    expect(UP).toMatch(/BEFORE UPDATE OR DELETE ON "audit_logs"\s+FOR EACH ROW/);
    expect(UP).toMatch(/BEFORE TRUNCATE ON "audit_logs"\s+FOR EACH STATEMENT/);
    expect(UP).toMatch(/ERRCODE = '23514'/);
    // Triggers, not grants (§4): no GRANT/REVOKE statement (the header comment explains why).
    expect(UP).not.toMatch(/^\s*(GRANT|REVOKE)\b/m);
  });

  it('the down file reverses exactly what 0034 added', () => {
    expect(DOWN).toMatch(/DROP TRIGGER IF EXISTS audit_logs_no_truncate_trg/);
    expect(DOWN).toMatch(/DROP TRIGGER IF EXISTS audit_logs_append_only_trg/);
    expect(DOWN).toMatch(/DELETE FROM "permissions" WHERE "resource" = 'audit_logs' AND "action" = 'read';/);
    expect(DOWN).not.toMatch(/DROP TABLE/);
    for (const column of ['actor_type', 'actor_roles', 'event_type', 'resource', 'action', 'target_type', 'target_id', 'reason', 'before_value', 'after_value', 'approval_ref', 'approval_chain', 'is_emergency_bypass', 'correlation_id']) {
      expect(DOWN).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });
});

describe.skipIf(!dbReachable)('migration 0034 — live schema (spec 039 §4)', () => {
  it('keeps baseColumns and actor_user_id; adds every §4 column with the right type and nullability', async () => {
    const rows = await queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
      getDb(),
      sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'audit_logs'`,
    );
    const col = Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}/${r.is_nullable}`]));
    expect(col).toMatchObject({
      id: 'uuid/NO',
      created_at: 'timestamp with time zone/NO',
      updated_at: 'timestamp with time zone/NO',
      version: 'integer/NO',
      actor_user_id: 'uuid/YES',
      actor_type: 'text/NO',
      actor_roles: 'jsonb/NO',
      event_type: 'text/NO',
      resource: 'text/NO',
      action: 'text/NO',
      target_type: 'text/YES',
      target_id: 'text/YES',
      reason: 'text/YES',
      before_value: 'jsonb/YES',
      after_value: 'jsonb/YES',
      approval_ref: 'uuid/YES',
      approval_chain: 'jsonb/NO',
      is_emergency_bypass: 'boolean/NO',
      correlation_id: 'text/YES',
    });
  });

  it('approval_ref is a RESTRICT foreign key to admin_actions, and every FK is indexed', async () => {
    const [fk] = await queryRows<{ confdeltype: string; target: string }>(
      getDb(),
      sql`SELECT confdeltype, confrelid::regclass::text AS target FROM pg_constraint WHERE conname = 'audit_logs_approval_ref_admin_actions_id_fk'`,
    );
    expect(fk).toEqual({ confdeltype: 'r', target: 'admin_actions' });
    const indexes = await queryRows<{ indexname: string }>(getDb(), sql`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_logs'`);
    const names = indexes.map((i) => i.indexname);
    for (const name of ['audit_logs_actor_user_id_idx', 'audit_logs_approval_ref_idx', 'audit_logs_created_at_idx', 'audit_logs_resource_created_at_idx', 'audit_logs_target_idx', 'audit_logs_correlation_id_idx', 'audit_logs_event_type_created_at_idx']) {
      expect(names).toContain(name);
    }
  });

  it('seeds audit_logs/read at tier low for exactly the seven roles', async () => {
    const rows = await queryRows<{ name: string; risk_tier: string }>(
      getDb(),
      sql`SELECT r.name, p.risk_tier FROM permissions p JOIN roles r ON r.id = p.role_id
           WHERE p.resource = 'audit_logs' AND p.action = 'read' ORDER BY r.name`,
    );
    expect(rows.map((r) => r.name)).toEqual(SEVEN_ROLES);
    expect(new Set(rows.map((r) => r.risk_tier))).toEqual(new Set(['low']));
  });

  describe('the CHECK constraints refuse malformed rows', () => {
    async function insertRefusal(values: string, params: unknown[]): Promise<string | undefined> {
      try {
        await getPool().query(`INSERT INTO audit_logs (actor_type, actor_user_id, event_type, resource, action, target_type, target_id, correlation_id) VALUES ${values}`, params);
      } catch (err) {
        return (err as { code?: string }).code;
      }
      return 'ACCEPTED';
    }

    it('an unknown actor type, a system actor with a user, a user actor without one', async () => {
      const user = await registerAndLogin();
      expect(await insertRefusal(`('ai', $1, 'e.x', 'r', 'a', null, null, null)`, [user.userId])).toBe('23514');
      expect(await insertRefusal(`('system', $1, 'e.x', 'r', 'a', null, null, null)`, [user.userId])).toBe('23514');
      expect(await insertRefusal(`('admin', null, 'e.x', 'r', 'a', null, null, null)`, [])).toBe('23514');
    });

    it('a target id without a type, a malformed correlation id, an empty event type', async () => {
      const user = await registerAndLogin();
      expect(await insertRefusal(`('user', $1, 'e.x', 'r', 'a', null, 'orphan', null)`, [user.userId])).toBe('23514');
      expect(await insertRefusal(`('user', $1, 'e.x', 'r', 'a', null, null, 'has spaces')`, [user.userId])).toBe('23514');
      expect(await insertRefusal(`('user', $1, '', 'r', 'a', null, null, null)`, [user.userId])).toBe('23514');
    });
  });
});
