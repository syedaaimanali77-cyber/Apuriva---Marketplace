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

/**
 * Spec 027 §6 "Migration" — `0023_add_file_assets`. Structural checks run against the shared test
 * database; REVERSIBILITY runs in a throwaway `*_test` database of its own, for the same reason spec
 * 026's block above does: applying a down migration to the shared one would pull columns out from
 * under every concurrently running suite.
 */
describe.skipIf(!dbReachable)('0023_add_file_assets migration (spec 027, integration)', () => {
  // Its own pool: the first block above ends the shared one in its `afterAll`.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => {
    await pool.end();
  });

  it('the baseline skeletons gain their columns, and NO table is added', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('file_assets','message_attachments')`,
    );
    const columns = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name);

    for (const added of [
      'kind', 'visibility', 'status', 'storage_key', 'mime_type', 'size_bytes', 'file_name',
      'checksum_sha256', 'context_type', 'context_id', 'scan_outcome', 'scan_attempts',
      'scan_next_attempt_at', 'rejection_reason', 'ready_at', 'deleted_at', 'storage_deleted_at',
      'legal_hold', 'idempotency_key', 'idempotency_fingerprint',
    ]) {
      expect(columns('file_assets'), added).toContain(added);
    }
    expect(columns('message_attachments')).toContain('file_asset_id');

    // Spec 015's linkage table is spec 015's, and is untouched by this migration.
    const requestAttachments = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'request_attachments'`,
    );
    expect(requestAttachments.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual(
      ['created_at', 'file_asset_id', 'id', 'request_id', 'updated_at', 'version'].sort(),
    );
  });

  it("every added file_assets column is nullable or defaulted, so spec 008's bare insert still works (AC-10)", async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'file_assets' AND column_name NOT IN ('id','created_at','updated_at','version','uploaded_by_user_id')`,
    );
    const offenders = rows.filter((r) => r.is_nullable === 'NO' && r.column_default === null);
    expect(offenders.map((r) => r.column_name)).toEqual([]);
  });

  it('the indexes this spec declares exist, with their partial predicates', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('file_assets','message_attachments')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.file_assets_storage_key_uq).toMatch(/UNIQUE INDEX .*\(storage_key\).*WHERE \(storage_key IS NOT NULL\)/);
    expect(byName.file_assets_owner_idempotency_uq).toMatch(
      /UNIQUE INDEX .*\(uploaded_by_user_id, idempotency_key\).*WHERE \(idempotency_key IS NOT NULL\)/,
    );
    expect(byName.file_assets_context_idx).toMatch(/\(context_type, context_id\)/);
    expect(byName.file_assets_scan_due_idx).toMatch(/\(status, scan_next_attempt_at\)/);
    expect(byName.file_assets_purge_idx).toMatch(/WHERE \(storage_deleted_at IS NULL\)/);
    // Spec 003's covering-index-per-FK rule, for the FK this migration adds.
    expect(byName.message_attachments_file_asset_id_idx).toMatch(/\(file_asset_id\)/);
  });

  it('the message_attachments FK is RESTRICT, so a linked asset can never be hard-deleted', async () => {
    const { rows } = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'message_attachments_file_asset_id_file_assets_id_fk'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confdeltype).toBe('r');
  });

  it('the ready-requires-clean CHECK rejects a hand-written violation (AC-4 at the database)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      // `ready` with no clean scan — exactly what application code must never do, refused anyway.
      await expect(
        client.query(
          `INSERT INTO file_assets (uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes, ready_at, context_type)
           VALUES ($1, 'image', 'private', 'ready', 'k/1', 'image/jpeg', 10, clock_timestamp(), 'request_attachment')`,
          [rows[0]!.id],
        ),
      ).rejects.toMatchObject({ constraint: 'file_assets_ready_requires_clean_ck' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the pairing and vocabulary CHECKs reject their violations', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const userId = rows[0]!.id;
      const insert = (columns: string, values: string) =>
        client.query(`INSERT INTO file_assets (uploaded_by_user_id, ${columns}) VALUES ($1, ${values})`, [userId]);

      for (const [columns, values, constraint] of [
        ['kind', `'executable'`, 'file_assets_kind_ck'],
        ['visibility', `'unlisted'`, 'file_assets_visibility_ck'],
        ['status', `'quarantined'`, 'file_assets_status_ck'],
        ['context_type', `'invented_context'`, 'file_assets_context_type_ck'],
        ['scan_outcome', `'probably_fine'`, 'file_assets_scan_outcome_ck'],
        // A context id with no context type is unauthorizable.
        ['context_id', `gen_random_uuid()`, 'file_assets_context_pairing_ck'],
        // A rejected row must always say why.
        ['status', `'rejected'`, 'file_assets_rejected_pairing_ck'],
        ['size_bytes', `-1`, 'file_assets_size_ck'],
        ['scan_attempts', `-1`, 'file_assets_scan_attempts_ck'],
      ] as const) {
        await client.query('SAVEPOINT s');
        await expect(insert(columns, values), `${columns} = ${values}`).rejects.toMatchObject({ constraint });
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the terminal trigger rejects a status change (AC-7 independently of application code)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: userRows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const { rows: assetRows } = await client.query<{ id: string }>(
        `INSERT INTO file_assets (uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes,
                                  scan_outcome, ready_at, context_type)
         VALUES ($1, 'image', 'private', 'ready', 'k/terminal', 'image/jpeg', 10, 'clean', clock_timestamp(), 'request_attachment')
         RETURNING id`,
        [userRows[0]!.id],
      );
      const assetId = assetRows[0]!.id;

      for (const attempt of [
        `UPDATE file_assets SET status = 'scanning', ready_at = NULL WHERE id = $1`,
        `UPDATE file_assets SET storage_key = 'k/moved' WHERE id = $1`,
        `UPDATE file_assets SET visibility = 'public' WHERE id = $1`,
        `UPDATE file_assets SET size_bytes = 999 WHERE id = $1`,
        `UPDATE file_assets SET context_type = 'portfolio' WHERE id = $1`,
      ]) {
        await client.query('SAVEPOINT s');
        await expect(client.query(attempt, [assetId]), attempt).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT s');
      }

      // The deletion/retention columns and the file name (for redaction) may still move.
      await expect(
        client.query(
          `UPDATE file_assets SET deleted_at = clock_timestamp(), file_name = '[redacted]', legal_hold = true WHERE id = $1`,
          [assetId],
        ),
      ).resolves.toBeTruthy();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('is reversible on an empty database, and the gated down refuses once an upload exists', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { Client } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { assertTestDatabaseUrl } = await import('@/test/test-database');

    const baseUrl = process.env.DATABASE_URL!;
    const baseName = assertTestDatabaseUrl(baseUrl);
    const scratchName = `${baseName.replace(/_test$/, '')}_m0023_test`;
    assertTestDatabaseUrl(`postgresql://x/${scratchName}`);
    const adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const scratchUrl = new URL(baseUrl);
    scratchUrl.pathname = `/${scratchName}`;

    const drizzleDir = join(__dirname, '..', '..', 'drizzle');
    const up = readFileSync(join(drizzleDir, '0023_add_file_assets.sql'), 'utf8');
    const down = readFileSync(join(drizzleDir, '0023_add_file_assets_down.sql'), 'utf8');

    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    const scratch = new Client({ connectionString: scratchUrl.toString() });
    try {
      await scratch.connect();
      await migrate(drizzle(scratch), { migrationsFolder: drizzleDir });

      const addedColumns = async () =>
        Number(
          (
            await scratch.query<{ n: string }>(
              `SELECT count(*) AS n FROM information_schema.columns
                WHERE table_name = 'file_assets' AND column_name IN ('kind','status','storage_key','context_type','legal_hold')`,
            )
          ).rows[0]!.n,
        );
      const triggerExists = async () =>
        (await scratch.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'file_assets_terminal_trg'`)).rowCount === 1;
      const attachmentColumn = async () =>
        (
          await scratch.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'message_attachments' AND column_name = 'file_asset_id'`,
          )
        ).rowCount === 1;

      expect(await addedColumns()).toBe(5);
      expect(await triggerExists()).toBe(true);

      await scratch.query(down);
      expect(await addedColumns()).toBe(0);
      expect(await triggerExists()).toBe(false);
      expect(await attachmentColumn()).toBe(false);
      // The baseline skeletons (and their spec 003 FK index) survive the rollback, and so does
      // spec 015's already-shipped linkage table.
      expect((await scratch.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'file_assets_uploaded_by_user_id_idx'`)).rowCount).toBe(1);
      expect(
        (
          await scratch.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'request_attachments' AND column_name = 'file_asset_id'`,
          )
        ).rowCount,
      ).toBe(1);

      await scratch.query(up);
      expect(await addedColumns()).toBe(5);
      expect(await triggerExists()).toBe(true);

      // AC-10: spec 008's bare export row does NOT block the rollback — it carries no storage_key,
      // so nothing would be orphaned. Rolling back with one present must still succeed.
      const { rows: userRows } = await scratch.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
      const userId = userRows[0]!.id;
      await scratch.query(`INSERT INTO file_assets (uploaded_by_user_id) VALUES ($1)`, [userId]);
      await expect(scratch.query(down)).resolves.toBeTruthy();
      await scratch.query(up);

      // But a REAL upload does block it: dropping storage_key would orphan stored bytes.
      await scratch.query(
        `INSERT INTO file_assets (uploaded_by_user_id, kind, status, storage_key, mime_type, size_bytes, context_type)
         VALUES ($1, 'image', 'pending', 'k/real-upload', 'image/jpeg', 10, 'request_attachment')`,
        [userId],
      );
      await expect(scratch.query(down)).rejects.toThrow(/Refusing to roll back 0023/);
      expect(await addedColumns()).toBe(5);
    } finally {
      await scratch.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.end();
    }
  }, 300_000);
});
