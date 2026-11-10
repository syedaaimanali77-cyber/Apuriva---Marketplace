import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/db';
import { isDatabaseReachable, useUrduLocaleFlag } from './i18n-test-support';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0037_add_user_locale.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0037_add_user_locale_down.sql'), 'utf8');

const statements = (file: string) =>
  file
    .split('--> statement-breakpoint')
    .flatMap((chunk) => chunk.split(/;\s*\n/))
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);

describe('migration 0037 — file-level guarantees (spec 042 §4, AC-5)', () => {
  it('is journal index 37, right after 0036, and the down file is not journalled', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    const index = tags.indexOf('0037_add_user_locale');
    expect(index).toBe(tags.indexOf('0036_implement_feature_flags') + 1);
    expect(journal.entries[index]!.idx).toBe(37);
    expect(tags).not.toContain('0037_add_user_locale_down');
  });

  it('the CHECK is shape-only: it lists no locale codes (adding a locale needs no schema change)', () => {
    const check = UP.match(/ADD CONSTRAINT "users_locale_shape_ck" CHECK \((.*)\);/)?.[1] ?? '';
    expect(check).toContain(`'^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`);
    expect(check).toContain('char_length("locale") <= 35');
    expect(check).not.toMatch(/'en'|'ur'|\bin \(/i);
  });

  it('seeds urdu-locale idempotently and off, and the down file reverses exactly that', () => {
    expect(UP).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    expect(UP).toMatch(/ON CONFLICT \("feature_flag_id", "environment"\) DO NOTHING/);
    expect(UP).toMatch(/SELECT f\."id", e\.environment, false/);
    expect(UP).not.toMatch(/UPDATE /);
    expect(DOWN).toMatch(/DELETE FROM "feature_flag_environment_values"/);
    expect(DOWN).toMatch(/DELETE FROM "feature_flags" WHERE "key" = 'urdu-locale'/);
    expect(DOWN).toMatch(/DROP CONSTRAINT IF EXISTS "users_locale_shape_ck"/);
    expect(DOWN).toMatch(/DROP COLUMN IF EXISTS "locale"/);
  });
});

describe.skipIf(!dbReachable)('migration 0037 — live schema, CHECK and seed (spec 042 §4)', () => {
  // Holds the spec 042 flag lock, so the staging value read below is not mid-toggle in another file.
  useUrduLocaleFlag();

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

  it('users.locale is a nullable text column', async () => {
    const { rows } = await getPool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'locale'`,
    );
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('the CHECK accepts en, ur, pt-BR and NULL, and rejects EN, xx_1 and an over-long tag', async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const id = rows[0]!.id;
      for (const ok of ['en', 'ur', 'pt-BR', null]) {
        await client.query('UPDATE users SET locale = $1 WHERE id = $2', [ok, id]);
      }
      for (const bad of ['EN', 'xx_1', `en${'-abcdefgh'.repeat(4)}` /* 38 characters */]) {
        await client.query('SAVEPOINT s');
        await expect(client.query('UPDATE users SET locale = $1 WHERE id = $2', [bad, id]), bad).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    });
  });

  it('seeds urdu-locale (business, client-readable, not a kill switch) OFF in all three environments', async () => {
    const { rows: flags } = await getPool().query(
      `SELECT controlled_by, is_kill_switch, client_readable FROM feature_flags WHERE key = 'urdu-locale'`,
    );
    expect(flags).toEqual([{ controlled_by: 'business', is_kill_switch: false, client_readable: true }]);
    const { rows: values } = await getPool().query<{ environment: string; enabled: boolean }>(
      `SELECT v.environment, v.enabled FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id
        WHERE f.key = 'urdu-locale' ORDER BY v.environment`,
    );
    expect(values).toEqual([
      { environment: 'development', enabled: false },
      { environment: 'production', enabled: false },
      { environment: 'staging', enabled: false },
    ]);
  });

  it('down then up round-trips cleanly (reversible), and re-running the up seed changes nothing', async () => {
    await withRollback(async (client) => {
      for (const statement of statements(DOWN)) await client.query(statement);
      const column = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'locale'`);
      expect(column.rowCount).toBe(0);
      const flag = await client.query(`SELECT 1 FROM feature_flags WHERE key = 'urdu-locale'`);
      expect(flag.rowCount).toBe(0);

      for (const statement of statements(UP)) await client.query(statement);
      const after = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'locale'`);
      expect(after.rowCount).toBe(1);
      const seeded = await client.query(
        `SELECT v.enabled FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id WHERE f.key = 'urdu-locale'`,
      );
      expect(seeded.rows).toEqual([{ enabled: false }, { enabled: false }, { enabled: false }]);

      const before = (await client.query('SELECT count(*)::int AS n FROM feature_flag_environment_values')).rows[0].n;
      for (const statement of statements(UP).filter((s) => /^INSERT INTO/.test(s))) await client.query(statement);
      expect((await client.query('SELECT count(*)::int AS n FROM feature_flag_environment_values')).rows[0].n).toBe(before);
    });
  });
});
