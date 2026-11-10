import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { assertTestDatabaseUrl } from '@/test/test-database';

const dbReachable = await isDatabaseReachable();
const DRIZZLE_DIR = join(__dirname, '..', '..', 'drizzle');

/**
 * Spec 033 §4 "Migration" — `0025_add_ai_usage_tracking`. Structural checks run against the shared
 * test database; REVERSIBILITY runs in a throwaway `*_test` database of its own, because applying a
 * down migration to the shared one would pull a table out from under every concurrently running
 * suite. Same shape as spec 026's `0022` block in `lib/db/migrations.integration.test.ts`.
 */
describe.skipIf(!dbReachable)('0025_add_ai_usage_tracking (spec 033, integration)', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => {
    await pool.end();
  });

  it('creates ai_usage_events with exactly its declared columns', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_usage_events'`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'id',
        'created_at',
        'updated_at',
        'version',
        'task',
        'subject_kind',
        'user_id',
        'subject_hash',
        'provider_name',
        'model_name',
        'outcome',
        'rejection_reason',
        'tokens_used',
        'cached',
        'latency_ms',
        'input_fingerprint',
      ].sort(),
    );
  });

  it('stores no prompt or response column (spec 033 §4 "Retention and privacy")', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage_events'`,
    );
    for (const row of rows) {
      expect(row.column_name).not.toMatch(/prompt|response|completion|content|message|output/);
    }
  });

  it('the user FK is RESTRICT and carries its covering index (spec 003 AC-4)', async () => {
    const { rows: fk } = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'ai_usage_events_user_id_users_id_fk'`,
    );
    expect(fk).toHaveLength(1);
    expect(fk[0]!.confdeltype).toBe('r');

    const { rows: idx } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ai_usage_events'`,
    );
    expect(idx.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'ai_usage_events_user_id_idx',
        'ai_usage_events_created_at_idx',
        'ai_usage_events_guest_subject_idx',
        'ai_usage_events_fingerprint_idx',
      ]),
    );
  });

  it('seeds ai/read_usage for exactly Analytics, Finance and Super Admin', async () => {
    const { rows } = await pool.query<{ name: string; risk_tier: string }>(
      `SELECT r.name, p.risk_tier FROM permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.resource = 'ai' AND p.action = 'read_usage'`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(['analytics_admin', 'finance_admin', 'super_admin']);
    expect(new Set(rows.map((r) => r.risk_tier))).toEqual(new Set(['low']));
  });

  it('the CHECK constraints reject every malformed row shape', async () => {
    const client = await pool.connect();
    const { rows: userRows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
    const userId = userRows[0]!.id;
    const base: Record<string, unknown> = {
      task: 'search_intent',
      provider_name: 'sandbox',
      model_name: 'rule-based',
      outcome: 'succeeded',
    };
    const insert = async (overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...base, ...overrides };
      const keys = Object.keys(row);
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO ai_usage_events (${keys.map((k) => `"${k}"`).join(',')})
           VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
          keys.map((k) => row[k]),
        );
        return null;
      } catch (err) {
        return (err as { constraint?: string }).constraint ?? 'error';
      } finally {
        await client.query('ROLLBACK');
      }
    };

    try {
      // A valid row of each kind is accepted.
      expect(await insert({ subject_kind: 'user', user_id: userId })).toBeNull();
      expect(await insert({ subject_kind: 'guest', subject_hash: 'abc' })).toBeNull();
      expect(await insert({ subject_kind: 'system' })).toBeNull();

      expect(await insert({ subject_kind: 'robot' })).toBe('ai_usage_events_subject_kind_ck');
      expect(await insert({ task: 'mind_reading', subject_kind: 'system' })).toBe('ai_usage_events_task_ck');
      expect(await insert({ outcome: 'maybe', subject_kind: 'system' })).toBe('ai_usage_events_outcome_ck');
      // A user row without its user id, and a system row carrying one.
      expect(await insert({ subject_kind: 'user' })).toBe('ai_usage_events_user_pairing_ck');
      expect(await insert({ subject_kind: 'system', user_id: userId })).toBe('ai_usage_events_user_pairing_ck');
      expect(await insert({ subject_kind: 'guest' })).toBe('ai_usage_events_guest_pairing_ck');
      // A rejection must say why, and only a rejection may.
      expect(await insert({ subject_kind: 'system', outcome: 'rejected' })).toBe('ai_usage_events_rejection_reason_ck');
      expect(await insert({ subject_kind: 'system', rejection_reason: 'rate_limited' })).toBe(
        'ai_usage_events_rejection_reason_ck',
      );
      expect(await insert({ subject_kind: 'system', outcome: 'rejected', rejection_reason: 'bored' })).toBe(
        'ai_usage_events_rejection_reason_ck',
      );
      expect(await insert({ subject_kind: 'system', tokens_used: -1 })).toBe('ai_usage_events_tokens_ck');
      expect(await insert({ subject_kind: 'system', latency_ms: -1 })).toBe('ai_usage_events_latency_ck');
      // A cache hit reaches no provider, so it can never have consumed tokens.
      expect(await insert({ subject_kind: 'system', cached: true, tokens_used: 5 })).toBe(
        'ai_usage_events_cached_tokens_ck',
      );
      expect(await insert({ subject_kind: 'system', cached: true, tokens_used: 0 })).toBeNull();
    } finally {
      client.release();
    }
  });

  it('ships no seeded usage row — a row exists only because a real call was accounted', () => {
    const up = readFileSync(join(DRIZZLE_DIR, '0025_add_ai_usage_tracking.sql'), 'utf8');
    expect(up).not.toMatch(/INSERT INTO "?ai_usage_events/i);
  });

  it('applies, rolls back and re-applies cleanly, and refuses to roll back once a row exists', async () => {
    const baseUrl = process.env.DATABASE_URL!;
    const baseName = assertTestDatabaseUrl(baseUrl);
    const scratchName = `${baseName.replace(/_test$/, '')}_m0025_test`;
    assertTestDatabaseUrl(`postgresql://x/${scratchName}`);
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const scratchUrl = new URL(baseUrl);
    scratchUrl.pathname = `/${scratchName}`;

    const up = readFileSync(join(DRIZZLE_DIR, '0025_add_ai_usage_tracking.sql'), 'utf8');
    const down = readFileSync(join(DRIZZLE_DIR, '0025_add_ai_usage_tracking_down.sql'), 'utf8');

    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    const scratch = new Client({ connectionString: scratchUrl.toString() });
    try {
      await scratch.connect();
      await migrate(drizzle(scratch), { migrationsFolder: DRIZZLE_DIR });

      const tableExists = async () =>
        (await scratch.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_usage_events'`)).rowCount === 1;
      const permissionCount = async () =>
        Number(
          (await scratch.query<{ n: string }>(`SELECT count(*) AS n FROM permissions WHERE resource = 'ai'`)).rows[0]!.n,
        );
      const aiBaselineTables = async () =>
        Number(
          (
            await scratch.query<{ n: string }>(
              `SELECT count(*) AS n FROM information_schema.tables
                WHERE table_name IN ('ai_conversations','ai_messages','ai_memories','ai_actions','ai_tool_calls')`,
            )
          ).rows[0]!.n,
        );

      // Applied.
      expect(await tableExists()).toBe(true);
      expect(await permissionCount()).toBe(3);
      expect(await aiBaselineTables()).toBe(5);

      // Rolled back on an empty table: the table and the permission rows go...
      await scratch.query(down);
      expect(await tableExists()).toBe(false);
      expect(await permissionCount()).toBe(0);
      // ...and specs 003/034/035/036's baseline AI tables are untouched.
      expect(await aiBaselineTables()).toBe(5);

      // Re-applied cleanly.
      await scratch.query(up);
      expect(await tableExists()).toBe(true);
      expect(await permissionCount()).toBe(3);

      // Once a real usage row exists, the rollback REFUSES rather than destroying cost history.
      await scratch.query(
        `INSERT INTO ai_usage_events (task, subject_kind, provider_name, model_name, outcome)
         VALUES ('search_intent', 'system', 'sandbox', 'rule-based', 'succeeded')`,
      );
      await expect(scratch.query(down)).rejects.toThrow(/Refusing to roll back 0025/);
      expect(await tableExists()).toBe(true);
    } finally {
      await scratch.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
