import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from './index';
import { isDatabaseReachable } from './test-support';

/**
 * Spec 003 Test plan: "migration applies cleanly to a fresh database; foreign keys/indexes
 * exist as declared." Requires a real Postgres reachable at DATABASE_URL with
 * 0001_baseline_schema already applied (`docker compose up -d && npm run db:migrate`) — see
 * README.md. Skips (not fails) if no DB is reachable, so `npm test` stays usable without Docker.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('0001_baseline_schema migration (integration)', () => {
  const pool = getPool();

  afterAll(async () => {
    await pool.end();
  });

  // 77 from 0001_baseline_schema (spec 003 §124's minimum list) + 3 from spec 009
  // (0005_add_spec_009_admin_rbac.sql: admin_role_assignments, admin_actions,
  // admin_action_approvals — see lib/db/schema-coverage.test.ts for why those three are legitimate
  // additions beyond §124's minimum, not baseline drift).
  it('creates all 80 tables (77 baseline + spec 009\'s 3 RBAC tables)', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(rows.length).toBe(80);
  });

  it('spot-checks a structural FK exists and defaults to RESTRICT', async () => {
    const { rows } = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conname = 'requests_customer_profile_id_customer_profiles_id_fk'`,
    );
    expect(rows).toHaveLength(1);
    // pg_constraint.confdeltype: 'r' = RESTRICT
    expect(rows[0]!.confdeltype).toBe('r');
  });

  it('spot-checks a covering index exists on a foreign-key column', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'requests' AND indexname = 'requests_customer_profile_id_idx'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('the generic status-transition trigger function exists', async () => {
    const { rows } = await pool.query(`SELECT proname FROM pg_proc WHERE proname = 'enforce_status_transition'`);
    expect(rows).toHaveLength(1);
  });

  it.each(['requests', 'offers', 'bookings', 'payments', 'payouts'])(
    '%s has its status-transition trigger attached',
    async (table) => {
      const { rows } = await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [
        table,
      ]);
      expect(rows.map((r: { tgname: string }) => r.tgname)).toContain(`${table}_status_transition_trg`);
    },
  );
});

/**
 * Spec 026 §6 "Migration" — `0022_add_notifications`. Structural checks run against the shared test
 * database; REVERSIBILITY runs in a throwaway `*_test` database of its own, because applying a down
 * migration to the shared one would pull columns out from under every concurrently running suite.
 */
describe.skipIf(!dbReachable)('0022_add_notifications migration (spec 026, integration)', () => {
  // Its own pool: the block above ends the shared one in its `afterAll`.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => {
    await pool.end();
  });

  it('the baseline tables gain their columns and notification_deliveries exists', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('notifications','notification_preferences','notification_deliveries')`,
    );
    const columns = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name).sort();
    expect(columns('notifications')).toEqual(
      ['body', 'category', 'created_at', 'event_key', 'id', 'params', 'read_at', 'recipient_user_id', 'title', 'type', 'updated_at', 'version'].sort(),
    );
    expect(columns('notification_preferences')).toEqual(
      ['categories', 'created_at', 'id', 'marketing_consent_at', 'marketing_consent_source', 'updated_at', 'user_id', 'version'].sort(),
    );
    expect(columns('notification_deliveries')).toContain('next_attempt_at');
  });

  it('the dedup and ordering indexes exist', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('notifications','notification_deliveries')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.notifications_event_key_uq).toMatch(/UNIQUE INDEX .*\(recipient_user_id, event_key\)/);
    expect(byName.notifications_recipient_created_idx).toMatch(/\(recipient_user_id, created_at DESC, id DESC\)/);
    expect(byName.notifications_unread_idx).toMatch(/WHERE \(read_at IS NULL\)/);
    expect(byName.notification_deliveries_status_due_idx).toMatch(/\(status, next_attempt_at\)/);
    expect(byName.notification_deliveries_notification_channel_uq).toMatch(/UNIQUE INDEX .*\(notification_id, channel\)/);
  });

  it('the category CHECK rejects an unknown value', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      await expect(
        client.query(
          `INSERT INTO notifications (recipient_user_id, category, type, title, body, event_key) VALUES ($1, 'marketing', 'promotion', 't', 'b', 'k')`,
          [rows[0]!.id],
        ),
      ).rejects.toMatchObject({ constraint: 'notifications_category_ck' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('is reversible on an empty database, and the down migration refuses once a notification exists', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { Client } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { assertTestDatabaseUrl } = await import('@/test/test-database');

    const baseUrl = process.env.DATABASE_URL!;
    const baseName = assertTestDatabaseUrl(baseUrl);
    const scratchName = `${baseName.replace(/_test$/, '')}_m0022_test`;
    assertTestDatabaseUrl(`postgresql://x/${scratchName}`);
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const scratchUrl = new URL(baseUrl);
    scratchUrl.pathname = `/${scratchName}`;

    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const up = readFileSync(join(drizzleDir, '0022_add_notifications.sql'), 'utf8');
    const down = readFileSync(join(drizzleDir, '0022_add_notifications_down.sql'), 'utf8');

    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    const scratch = new Client({ connectionString: scratchUrl.toString() });
    try {
      await scratch.connect();
      await migrate(drizzle(scratch), { migrationsFolder: drizzleDir });
      const columnCount = async () =>
        Number(
          (
            await scratch.query<{ n: string }>(
              `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'notifications' AND column_name IN ('category','event_key','read_at')`,
            )
          ).rows[0]!.n,
        );
      const tableExists = async () =>
        (await scratch.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'notification_deliveries'`)).rowCount === 1;

      expect(await columnCount()).toBe(3);
      await scratch.query(down);
      expect(await columnCount()).toBe(0);
      expect(await tableExists()).toBe(false);
      // The baseline skeletons (and their spec 003 FK index) survive the rollback.
      expect((await scratch.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'notifications_recipient_user_id_idx'`)).rowCount).toBe(1);

      await scratch.query(up);
      expect(await columnCount()).toBe(3);
      expect(await tableExists()).toBe(true);

      const { rows } = await scratch.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      await scratch.query(
        `INSERT INTO notifications (recipient_user_id, category, type, title, body, event_key) VALUES ($1, 'security', 'security_alert', 't', 'b', 'k')`,
        [rows[0]!.id],
      );
      await expect(scratch.query(down)).rejects.toThrow(/Refusing to roll back 0022/);
      expect(await columnCount()).toBe(3);
    } finally {
      await scratch.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 300_000);
});
