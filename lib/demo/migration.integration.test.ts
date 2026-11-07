import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/db';
import { isDatabaseReachable } from './demo-test-support';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0039_add_demo_mode.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0039_add_demo_mode_down.sql'), 'utf8');

/** Each statement of a migration file, comments removed — the way `npm run db:migrate` splits them. */
const statements = (file: string) =>
  file
    .split('--> statement-breakpoint')
    .flatMap((chunk) => chunk.split(/;\s*\n/))
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);

describe('migration 0039 — file-level guarantees (spec 045 §4)', () => {
  it('is journal index 39, right after 0038, and the down file is not journalled', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    const index = tags.indexOf('0039_add_demo_mode');
    expect(index).toBe(tags.indexOf('0038_add_cron_job_heartbeats') + 1);
    expect(journal.entries[index]!.idx).toBe(39);
    expect(tags).not.toContain('0039_add_demo_mode_down');
  });

  it('adds the columns, CHECK and partial index, seeds the flag off idempotently, and seeds no demo data', () => {
    expect(UP).toMatch(/ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL/);
    expect(UP).toMatch(/ADD COLUMN "demo_set_id" uuid/);
    expect(UP).toMatch(/"users_demo_set_ck" CHECK \("demo_set_id" is null or "is_demo"\)/);
    expect(UP).toMatch(/"users_demo_set_idx" ON "users" USING btree \("demo_set_id"\) WHERE "demo_set_id" is not null/);
    expect(UP).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    expect(UP).toMatch(/ON CONFLICT \("feature_flag_id", "environment"\) DO NOTHING/);
    expect(UP).toMatch(/SELECT f\."id", e\.environment, false/);
    expect(UP).not.toMatch(/INSERT INTO "users"/);
    expect(UP).not.toMatch(/UPDATE /);
  });

  it('the down file reverses exactly that', () => {
    expect(DOWN).toMatch(/DELETE FROM "feature_flag_environment_values"/);
    expect(DOWN).toMatch(/DELETE FROM "feature_flags" WHERE "key" = 'demo-mode'/);
    expect(DOWN).toMatch(/DROP INDEX IF EXISTS "users_demo_set_idx"/);
    expect(DOWN).toMatch(/DROP CONSTRAINT IF EXISTS "users_demo_set_ck"/);
    expect(DOWN).toMatch(/DROP COLUMN IF EXISTS "demo_set_id"/);
    expect(DOWN).toMatch(/DROP COLUMN IF EXISTS "is_demo"/);
  });
});

describe.skipIf(!dbReachable)('migration 0039 — live schema, CHECK, index and seed (spec 045 §4)', () => {
  /** Runs on one connection inside a transaction that is always rolled back, so nothing persists. */
  async function withRollback(run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('existing users default to is_demo = false; the CHECK refuses a set id on a non-demo user', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ id: string; is_demo: boolean }>(
        `INSERT INTO users (email) VALUES ('migration-0039-' || gen_random_uuid() || '@example.test') RETURNING id, is_demo`,
      );
      expect(rows[0]!.is_demo).toBe(false);
      await client.query('SAVEPOINT s');
      await expect(client.query(`UPDATE users SET demo_set_id = gen_random_uuid() WHERE id = $1`, [rows[0]!.id])).rejects.toMatchObject({
        constraint: 'users_demo_set_ck',
      });
      await client.query('ROLLBACK TO SAVEPOINT s');
      await client.query(`UPDATE users SET is_demo = true, demo_set_id = gen_random_uuid() WHERE id = $1`, [rows[0]!.id]);
    });
  });

  it('the partial index exists, and the flag is seeded off in all three environments', async () => {
    await withRollback(async (client) => {
      const index = await client.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'users_demo_set_idx'`);
      expect(index.rows[0]!.indexdef).toMatch(/WHERE \(demo_set_id IS NOT NULL\)/);
      const flag = await client.query<{ controlled_by: string; client_readable: boolean; environment: string; enabled: boolean }>(
        `SELECT f.controlled_by, f.client_readable, v.environment, v.enabled
           FROM feature_flags f JOIN feature_flag_environment_values v ON v.feature_flag_id = f.id
          WHERE f.key = 'demo-mode' ORDER BY v.environment`,
      );
      expect(flag.rows).toEqual([
        { controlled_by: 'developer', client_readable: false, environment: 'development', enabled: false },
        { controlled_by: 'developer', client_readable: false, environment: 'production', enabled: false },
        { controlled_by: 'developer', client_readable: false, environment: 'staging', enabled: false },
      ]);
    });
  });

  it('down then up round-trips cleanly, and the seed is idempotent', async () => {
    await withRollback(async (client) => {
      for (const statement of statements(DOWN)) await client.query(statement);
      const gone = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('is_demo', 'demo_set_id')`);
      expect(gone.rowCount).toBe(0);
      expect((await client.query(`SELECT 1 FROM feature_flags WHERE key = 'demo-mode'`)).rowCount).toBe(0);

      for (const statement of statements(UP)) await client.query(statement);
      for (const statement of statements(UP).filter((s) => s.startsWith('INSERT'))) await client.query(statement);
      const back = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('is_demo', 'demo_set_id')`);
      expect(back.rowCount).toBe(2);
      expect((await client.query(`SELECT count(*)::int AS n FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id WHERE f.key = 'demo-mode'`)).rows[0]).toEqual({ n: 3 });
    });
  });
});
