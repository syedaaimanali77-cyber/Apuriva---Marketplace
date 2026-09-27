import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { FEATURE_FLAG_REGISTRY } from './registry';
import { isDatabaseReachable } from './feature-flags-test-support';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0036_implement_feature_flags.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0036_implement_feature_flags_down.sql'), 'utf8');

describe('migration 0036 — file-level guarantees (spec 041 §4)', () => {
  it('is the next journal entry after 0035, and the down file is not journalled', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    const index = tags.indexOf('0036_implement_feature_flags');
    expect(index).toBe(tags.indexOf('0035_implement_analytics_events') + 1);
    expect(journal.entries[index]!.idx).toBe(36);
    expect(tags).not.toContain('0036_implement_feature_flags_down');
  });

  it('ALTERS the spec 003 stub, creates the value table, and seeds idempotently', () => {
    expect(UP).toMatch(/ALTER TABLE "feature_flags"/);
    expect(UP).not.toMatch(/CREATE TABLE[^;]*"feature_flags"\s*\(/);
    expect(UP).toMatch(/CREATE TABLE IF NOT EXISTS "feature_flag_environment_values"/);
    expect(UP).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    expect(UP).toMatch(/ON CONFLICT \("feature_flag_id", "environment"\) DO NOTHING/);
    // Spec 042 X-15: checked against 0036 only for 0036's own six flags; later flags ship in their own migration.
    for (const flag of FEATURE_FLAG_REGISTRY.filter((f) => f.owningSpec !== '042')) {
      expect(UP).toContain(`'${flag.key}', '${flag.description.replace(/'/g, "''")}'`);
    }
  });

  it('the down file reverses exactly what 0036 added', () => {
    expect(DOWN).toContain(`DELETE FROM "permissions" WHERE "resource" = 'feature_flags' AND "action" IN ('read','toggle','read_technical','toggle_technical');`);
    expect(DOWN).toContain('DROP TABLE IF EXISTS "feature_flag_environment_values"');
    for (const column of ['removal_criteria', 'client_readable', 'is_kill_switch', 'controlled_by', 'description', 'key']) {
      expect(DOWN).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
    expect(DOWN).not.toMatch(/DROP TABLE IF EXISTS "feature_flags"/);
  });
});

describe.skipIf(!dbReachable)('migration 0036 — live schema and seed (spec 041 §4, AC-5)', () => {
  it('feature_flags keeps baseColumns and gains the §4 columns', async () => {
    const rows = await queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
      getDb(),
      sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'feature_flags'`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}/${r.is_nullable}`]))).toEqual({
      id: 'uuid/NO',
      created_at: 'timestamp with time zone/NO',
      updated_at: 'timestamp with time zone/NO',
      version: 'integer/NO',
      key: 'text/NO',
      description: 'text/NO',
      controlled_by: 'text/NO',
      is_kill_switch: 'boolean/NO',
      client_readable: 'boolean/NO',
      removal_criteria: 'text/YES',
    });
  });

  it('seeds exactly the registry: every registered flag (the six of 0036 plus urdu-locale of spec 042) matching §3.3, three environment values each with the documented default', async () => {
    const flags = await queryRows<{ key: string; description: string; controlled_by: string; is_kill_switch: boolean; client_readable: boolean }>(
      getDb(),
      sql`SELECT key, description, controlled_by, is_kill_switch, client_readable FROM feature_flags ORDER BY key`,
    );
    expect(flags).toEqual(
      FEATURE_FLAG_REGISTRY.map((f) => ({
        key: f.key,
        description: f.description,
        controlled_by: f.controlledBy,
        is_kill_switch: f.isKillSwitch,
        client_readable: f.clientReadable,
      })).sort((a, b) => a.key.localeCompare(b.key)),
    );
    const values = await queryRows<{ key: string; environment: string }>(
      getDb(),
      sql`SELECT f.key, v.environment FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id`,
    );
    expect(values).toHaveLength(FEATURE_FLAG_REGISTRY.length * 3);
    for (const flag of FEATURE_FLAG_REGISTRY) {
      expect(values.filter((v) => v.key === flag.key).map((v) => v.environment).sort()).toEqual(['development', 'production', 'staging']);
    }
    // The development seed is the documented default (the rows other environments' tests toggle are restored by them).
    const dev = await queryRows<{ key: string; enabled: boolean; updated_by_admin_id: string | null }>(
      getDb(),
      sql`SELECT f.key, v.enabled, v.updated_by_admin_id FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id
           WHERE v.environment = 'development'`,
    );
    for (const flag of FEATURE_FLAG_REGISTRY) expect(dev.find((d) => d.key === flag.key)!.enabled, flag.key).toBe(flag.defaults.development);
  });

  it('the CHECKs reject a bad key, a developer client-readable flag, and a bad environment', async () => {
    const client = await getPool().connect();
    const expectCheck = async (statement: string) => {
      await client.query('BEGIN');
      try {
        await expect(client.query(statement)).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      await expectCheck(`INSERT INTO feature_flags (key, description, controlled_by) VALUES ('Bad_Key', 'd', 'business')`);
      await expectCheck(`INSERT INTO feature_flags (key, description, controlled_by, client_readable) VALUES ('leak-flag', 'd', 'developer', true)`);
      await expectCheck(`INSERT INTO feature_flags (key, description, controlled_by) VALUES ('who-flag', 'd', 'marketing')`);
      await expectCheck(
        `INSERT INTO feature_flag_environment_values (feature_flag_id, environment, enabled) SELECT id, 'qa', true FROM feature_flags LIMIT 1`,
      );
      await client.query('BEGIN');
      try {
        await expect(
          client.query(`INSERT INTO feature_flag_environment_values (feature_flag_id, environment, enabled) SELECT id, 'staging', true FROM feature_flags WHERE key = 'ai-assistant'`),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('seeds the four §3.5 permissions for exactly the approved roles', async () => {
    const { rows } = await getPool().query<{ name: string; action: string; risk_tier: string }>(
      `SELECT r.name, p.action, p.risk_tier FROM permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.resource = 'feature_flags' ORDER BY p.action, r.name`,
    );
    expect(rows.map((r) => `${r.action}:${r.name}:${r.risk_tier}`)).toEqual([
      'read:content_admin:low',
      'read:operations_admin:low',
      'read:super_admin:low',
      'read_technical:super_admin:low',
      'toggle:content_admin:medium',
      'toggle:operations_admin:medium',
      'toggle:super_admin:medium',
      'toggle_technical:super_admin:medium',
    ]);
  });

  it('re-running the seed changes nothing (idempotent)', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query('SELECT count(*)::int AS n FROM feature_flag_environment_values')).rows[0].n;
      const seeds = UP.split('--> statement-breakpoint').filter((s) => /INSERT INTO/.test(s));
      for (const statement of seeds) await client.query(statement);
      const after = (await client.query('SELECT count(*)::int AS n FROM feature_flag_environment_values')).rows[0].n;
      expect(after).toBe(before);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
