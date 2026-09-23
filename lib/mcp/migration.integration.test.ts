/**
 * Spec 035 §4 "Migration" — that `0031` did what §4 says, and that its `_down.sql` reverses exactly
 * that and nothing else. UP is checked against the LIVE test database (migrated by the harness);
 * DOWN is ACTUALLY RUN inside a transaction that is then rolled back — the approach specs 032 and
 * 034 established.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable, registerAndLogin } from './mcp-test-support';

const reachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0031_add_mcp_authorization.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0031_add_mcp_authorization_down.sql'), 'utf8');
const JOURNAL = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };

/** The executable SQL only — these files explain at length what they deliberately do NOT do. */
function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const UP_SQL = statements(UP);
const DOWN_SQL = statements(DOWN);

describe('migration 0031 — file-level guarantees (spec 035 §4)', () => {
  it('creates exactly this specs two tables and no other', () => {
    const created = [...UP_SQL.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g)].map((match) => match[1]);
    expect(created.sort()).toEqual(['mcp_confirmation_parameters', 'mcp_confirmations']);
  });

  it('never touches ai_actions, any other spec 034 table, or the immutable baseline migration', () => {
    for (const source of [UP_SQL, DOWN_SQL]) {
      expect(source).not.toMatch(/ai_actions|ai_conversations|ai_messages|ai_memories|ai_tool_calls/);
      expect(source).not.toMatch(/0001_baseline_schema/);
    }
  });

  it('creates no audit table — spec 039 owns the audit log', () => {
    expect(UP_SQL).not.toMatch(/audit_log/i);
  });

  it('uses no jsonb: the bound parameters are relational (spec 003 AC-5)', () => {
    expect(UP_SQL).not.toMatch(/jsonb/i);
  });

  it('adds no float money column and uses timestamptz throughout (spec 003 AC-1/AC-2)', () => {
    expect(UP_SQL).not.toMatch(/numeric|real|double precision/i);
    expect(UP_SQL).not.toMatch(/timestamp(?! with time zone)/i);
  });

  it('limits the confirmed tiers to medium and high — low needs none, restricted is refused', () => {
    expect(UP_SQL).toContain(`CHECK ("mcp_confirmations"."risk_tier" in ('medium','high'))`);
    expect(UP_SQL).not.toMatch(/'restricted'/);
  });

  it('indexes every foreign key and seeds only this specs own permission', () => {
    expect(UP_SQL).toContain('"mcp_confirmations_user_id_idx"');
    expect(UP_SQL).toContain('"mcp_confirmation_parameters_mcp_confirmation_id_idx"');
    expect(UP_SQL).toContain("'mcp', 'read_registry', 'low'");
    expect(UP_SQL).toMatch(/ON DELETE restrict/);
    expect(UP_SQL).not.toMatch(/ON DELETE (cascade|set null)/i);
  });

  it('is journaled, while the down migration is not', () => {
    const tags = JOURNAL.entries.map((entry) => entry.tag);
    expect(tags).toContain('0031_add_mcp_authorization');
    expect(tags).not.toContain('0031_add_mcp_authorization_down');
  });

  it('the down migration refuses to run once a confirmation exists, and removes only this specs seed', () => {
    expect(DOWN).toMatch(/RAISE EXCEPTION/);
    expect(DOWN).toContain('FROM "mcp_confirmations"');
    expect(DOWN_SQL).toContain(`DELETE FROM "permissions" WHERE "resource" = 'mcp'`);
    expect(DOWN_SQL).not.toMatch(/DELETE FROM "permissions" WHERE "resource" = '(?!mcp)/);
  });
});

describe.skipIf(!reachable)('migration 0031 — applied shape (live database)', () => {
  it('created both tables with the spec 003 baseline columns', async () => {
    const rows = await queryRows<{ table_name: string; column_name: string; data_type: string }>(
      getDb(),
      sql`SELECT table_name, column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name IN ('mcp_confirmations','mcp_confirmation_parameters')`,
    );
    const has = (table: string, column: string) => rows.some((r) => r.table_name === table && r.column_name === column);

    for (const table of ['mcp_confirmations', 'mcp_confirmation_parameters']) {
      for (const column of ['id', 'created_at', 'updated_at', 'version']) expect(has(table, column), `${table}.${column}`).toBe(true);
    }
    for (const column of ['user_id', 'tool_name', 'risk_tier', 'expires_at', 'consumed_at']) {
      expect(has('mcp_confirmations', column), `mcp_confirmations.${column}`).toBe(true);
    }
    for (const column of ['mcp_confirmation_id', 'label', 'value', 'sort_order']) {
      expect(has('mcp_confirmation_parameters', column), `mcp_confirmation_parameters.${column}`).toBe(true);
    }

    // Every timestamp is timestamptz (spec 003 AC-2), and no jsonb column exists (AC-5).
    const timestamps = rows.filter((r) => r.data_type.startsWith('timestamp'));
    expect(timestamps.every((r) => r.data_type === 'timestamp with time zone')).toBe(true);
    expect(rows.some((r) => r.data_type === 'jsonb')).toBe(false);
  });

  it('installed the CHECK, the covering indexes and the per-binding label uniqueness', async () => {
    const constraints = (
      await queryRows<{ conname: string }>(getDb(), sql`SELECT conname FROM pg_constraint WHERE conname LIKE 'mcp_%'`)
    ).map((row) => row.conname);
    expect(constraints).toContain('mcp_confirmations_risk_tier_ck');

    const indexes = (
      await queryRows<{ indexname: string }>(getDb(), sql`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'mcp_%'`)
    ).map((row) => row.indexname);
    for (const index of [
      'mcp_confirmations_user_id_idx',
      'mcp_confirmations_expires_at_idx',
      'mcp_confirmation_parameters_mcp_confirmation_id_idx',
      'mcp_confirmation_parameters_confirmation_label_uq',
    ]) {
      expect(indexes, index).toContain(index);
    }
  });

  it('seeded mcp/read_registry for exactly Super Admin', async () => {
    const roles = (
      await queryRows<{ name: string }>(
        getDb(),
        sql`SELECT r.name FROM permissions p JOIN roles r ON r.id = p.role_id
             WHERE p.resource = 'mcp' AND p.action = 'read_registry'`,
      )
    ).map((row) => row.name);
    expect(roles.sort()).toEqual(['super_admin']);
  });

  it('the down migration REFUSES while a confirmation exists — the guard, exercised for real', async () => {
    // A confirmation belongs to a real user: the foreign key is RESTRICT, so one must exist.
    const session = await registerAndLogin();

    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO mcp_confirmations (user_id, tool_name, risk_tier, expires_at)
          VALUES (${session.userId}, 'guard_probe', 'high', now() + interval '15 minutes')`);
        await tx.execute(sql.raw(DOWN_SQL));
        // Reached only if the guard did NOT fire. Throwing keeps the transaction from committing a
        // DROP of tables this suite must leave exactly as it found them, and fails the test loudly.
        throw new Error('the down migration dropped the tables while a confirmation existed');
      }),
    ).rejects.toThrow(/Refusing to roll back 0031/);
  });

  it('the down migration actually runs on an empty table, inside a transaction that is then rolled back', async () => {
    await expect(
      getDb().transaction(async (tx) => {
        // Earlier suites in this run may have left bindings behind. Clearing them INSIDE the
        // transaction keeps this deterministic and is undone by the rollback below.
        await tx.execute(sql`DELETE FROM mcp_confirmation_parameters`);
        await tx.execute(sql`DELETE FROM mcp_confirmations`);
        await tx.execute(sql.raw(DOWN_SQL));
        const remaining = await queryRows<{ table_name: string }>(
          tx as unknown as Parameters<typeof queryRows>[0],
          sql`SELECT table_name FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name IN ('mcp_confirmations','mcp_confirmation_parameters')`,
        );
        expect(remaining).toEqual([]);
        // Roll back: this suite must leave the schema exactly as it found it.
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const stillThere = await queryRows<{ table_name: string }>(
      getDb(),
      sql`SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name IN ('mcp_confirmations','mcp_confirmation_parameters')`,
    );
    expect(stillThere).toHaveLength(2);
  });
});
