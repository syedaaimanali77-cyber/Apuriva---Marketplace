/**
 * Spec 031 §6 "Migration / rollback" — that `0028` did what §4 says, and that its `_down.sql`
 * reverses exactly that and nothing else.
 *
 * The UP direction is verified against the LIVE test database, which the harness migrated before
 * this file ran — so these assertions are about the schema the application actually talks to, not
 * about the text of a file. The DOWN direction is verified by reading the `_down.sql` and checking
 * it reverses each object the up-migration created, including restoring the two plain indexes it
 * replaced with unique ones.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable } from './disputes-test-support';

const reachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0028_add_disputes_resolution.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0028_add_disputes_resolution_down.sql'), 'utf8');

/**
 * The EXECUTABLE SQL only, with `--` comments stripped.
 *
 * These migrations explain at length what they deliberately do NOT do — they name
 * `0001_baseline_schema`, `numeric`, `file_assets_context_type_ck` and so on precisely to record
 * that those are untouched. An assertion run against the raw text would therefore fail on the
 * prose that proves it right, so the "this migration never does X" checks run against statements.
 */
function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const UP_SQL = statements(UP);
const DOWN_SQL = statements(DOWN);

describe('migration 0028 — file-level guarantees (spec 031 §4)', () => {
  it('creates NO table: all five are spec 003 baseline skeletons', () => {
    expect(UP_SQL).not.toMatch(/CREATE TABLE/i);
  });

  it('never touches the immutable baseline migration', () => {
    expect(UP_SQL).not.toMatch(/0001_baseline_schema/i);
  });

  it('refuses to apply if any disputes table already holds data — no silent defaulting', () => {
    expect(UP).toMatch(/RAISE EXCEPTION/);
    for (const table of ['disputes', 'dispute_evidence', 'dispute_messages', 'dispute_resolutions', 'dispute_appeals']) {
      expect(UP).toContain(`FROM "${table}"`);
    }
  });

  it('is statement-broken throughout, so a partial failure is recoverable', () => {
    expect(UP.split('--> statement-breakpoint').length).toBeGreaterThan(40);
  });

  it('seeds both booking transitions and all three permissions idempotently', () => {
    expect(UP).toMatch(/\('protected', 'disputed'\)/);
    expect(UP).toMatch(/\('disputed', 'protected'\)/);
    expect(UP).toMatch(/ON CONFLICT \("from_status", "to_status"\) DO NOTHING/);

    expect(UP).toMatch(/\('disputes', 'read', 'low'\)/);
    expect(UP).toMatch(/\('disputes', 'resolve', 'medium'\)/);
    expect(UP).toMatch(/\('disputes', 'review_appeal', 'medium'\)/);
    expect(UP).toMatch(/ON CONFLICT \("role_id", "resource", "action"\) DO NOTHING/);
  });

  it('grants read to Operations but resolve/review_appeal only to Trust & Safety and Super Admin', () => {
    const readSeed = UP.slice(UP.indexOf("('disputes', 'read', 'low')"));
    expect(readSeed).toMatch(/'operations_admin', 'trust_safety_admin', 'super_admin'/);

    const decideSeed = UP.slice(UP.indexOf("('disputes', 'resolve', 'medium')"));
    expect(decideSeed).toMatch(/'trust_safety_admin', 'super_admin'/);
    // Operations must not be able to decide a dispute.
    expect(decideSeed.slice(0, decideSeed.indexOf('DO NOTHING'))).not.toMatch(/operations_admin/);
  });

  it('adds no money column of a float type, and names the pair semantically (spec 003 AC-1)', () => {
    expect(UP_SQL).toMatch(/"proposed_refund_amount_minor_units" integer/);
    expect(UP_SQL).toMatch(/"proposed_refund_currency_code" text/);
    expect(UP_SQL).not.toMatch(/numeric|real|double precision/i);
  });

  it('points the refund linkage at spec 009 admin_actions, never at refunds', () => {
    expect(UP).toMatch(/"refund_admin_action_id" uuid/);
    expect(UP).toMatch(/REFERENCES "public"\."admin_actions"\("id"\)/);
    expect(UP_SQL).not.toMatch(/REFERENCES "public"\."refunds"/);
  });

  it('adds no column to refunds, payouts, payments or bookings', () => {
    for (const table of ['refunds', 'payouts', 'payments', 'bookings']) {
      expect(UP_SQL).not.toMatch(new RegExp(`ALTER TABLE "${table}" ADD COLUMN`, 'i'));
    }
  });

  it('widens no existing vocabulary — dispute_evidence and disputed predate this spec', () => {
    expect(UP_SQL).not.toMatch(/file_assets_context_type_ck/);
    expect(UP_SQL).not.toMatch(/bookings_status_ck/);
    expect(UP_SQL).not.toMatch(/payments_protection_state_ck/);
  });

  it('uses RESTRICT on every foreign key it adds', () => {
    const fks = [...UP.matchAll(/ADD CONSTRAINT "[^"]+_fk" FOREIGN KEY[^;]*/g)].map((m) => m[0]);
    expect(fks.length).toBeGreaterThan(0);
    for (const fk of fks) {
      expect(fk).toMatch(/ON DELETE restrict/);
    }
  });
});

describe('migration 0028 down — reverses exactly the up (spec 031 §9 "Rollback")', () => {
  it('drops every table nothing: the spec 003 skeletons survive a rollback', () => {
    expect(DOWN_SQL).not.toMatch(/DROP TABLE/i);
  });

  it('restores the two plain indexes the up-migration replaced with unique ones', () => {
    expect(DOWN).toMatch(/CREATE INDEX IF NOT EXISTS "dispute_resolutions_dispute_id_idx"/);
    expect(DOWN).toMatch(/CREATE INDEX IF NOT EXISTS "dispute_appeals_dispute_id_idx"/);
    expect(DOWN).toMatch(/DROP INDEX IF EXISTS "dispute_resolutions_dispute_uq"/);
    expect(DOWN).toMatch(/DROP INDEX IF EXISTS "dispute_appeals_dispute_uq"/);
  });

  it('drops every column the up-migration added', () => {
    const added = [...UP.matchAll(/ALTER TABLE "([a-z_]+)" ADD COLUMN "([a-z_]+)"/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(added.length).toBeGreaterThan(20);
    for (const pair of added) {
      const [, column] = pair.split('.');
      expect(DOWN).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });

  it('removes the seeded transitions and permissions, leaving role assignments alone', () => {
    expect(DOWN).toMatch(/DELETE FROM "bookings_status_transitions"/);
    expect(DOWN).toMatch(/DELETE FROM "permissions" WHERE "resource" = 'disputes'/);
    expect(DOWN_SQL).not.toMatch(/DELETE FROM "admin_role_assignments"/);
  });

  it('never deletes audit records or file assets — audit outlives the feature', () => {
    expect(DOWN_SQL).not.toMatch(/DELETE FROM "security_events"/);
    expect(DOWN_SQL).not.toMatch(/DELETE FROM "file_assets"/);
  });

  it('refuses to destroy real dispute content, and says so', () => {
    expect(DOWN).toMatch(/RAISE EXCEPTION/);
    expect(DOWN).toMatch(/Refusing to roll back 0028/);
  });

  it('carries no journal entry, so db:migrate never applies it', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.some((e) => e.tag === '0028_add_disputes_resolution')).toBe(true);
    expect(journal.entries.some((e) => e.tag.includes('_down'))).toBe(false);
  });
});

describe.skipIf(!reachable)('migration 0028 — applied shape in the live test database', () => {
  async function indexes(table: string): Promise<{ indexname: string; indexdef: string }[]> {
    return queryRows(getDb(), sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${table}`);
  }

  it('created the partial unique index that makes duplicate live disputes impossible', async () => {
    const found = (await indexes('disputes')).find((i) => i.indexname === 'disputes_booking_open_uq');
    expect(found).toBeTruthy();
    expect(found!.indexdef).toMatch(/UNIQUE/);
    expect(found!.indexdef).toMatch(/WHERE \(status <> 'closed'/);
  });

  it('created the unique indexes behind one-resolution and one-appeal', async () => {
    expect((await indexes('dispute_resolutions')).some((i) => i.indexname === 'dispute_resolutions_dispute_uq')).toBe(true);
    expect((await indexes('dispute_appeals')).some((i) => i.indexname === 'dispute_appeals_dispute_uq')).toBe(true);
  });

  it('seeded exactly the two booking transitions this spec owns', async () => {
    const rows = await queryRows<{ from_status: string; to_status: string }>(
      getDb(),
      sql`SELECT from_status, to_status FROM bookings_status_transitions
           WHERE from_status = 'disputed' OR to_status = 'disputed'
           ORDER BY from_status`,
    );
    expect(rows).toEqual([
      { from_status: 'disputed', to_status: 'protected' },
      { from_status: 'protected', to_status: 'disputed' },
    ]);
  });

  it('seeded the three permissions to the roles DECIDED-2 names, and no others', async () => {
    const rows = await queryRows<{ action: string; name: string; risk_tier: string }>(
      getDb(),
      sql`SELECT p.action, r.name, p.risk_tier
            FROM permissions p JOIN roles r ON r.id = p.role_id
           WHERE p.resource = 'disputes'
           ORDER BY p.action, r.name`,
    );

    const byAction = (action: string) => rows.filter((r) => r.action === action).map((r) => r.name).sort();
    expect(byAction('read')).toEqual(['operations_admin', 'super_admin', 'trust_safety_admin']);
    expect(byAction('resolve')).toEqual(['super_admin', 'trust_safety_admin']);
    expect(byAction('review_appeal')).toEqual(['super_admin', 'trust_safety_admin']);

    // Every tier is low/medium, which is WHY this spec never calls `authorizeAndInitiate`.
    expect(rows.every((r) => r.risk_tier === 'low' || r.risk_tier === 'medium')).toBe(true);
    // Finance is deliberately absent — it sees the refund through spec 022's own `refunds/read`.
    expect(rows.some((r) => r.name === 'finance_admin')).toBe(false);
  });

  it('every dispute foreign-key column has a covering index (spec 003 AC-4)', async () => {
    for (const table of ['disputes', 'dispute_evidence', 'dispute_messages', 'dispute_resolutions', 'dispute_appeals']) {
      const fks = await queryRows<{ column_name: string }>(
        getDb(),
        sql`SELECT kcu.column_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
             WHERE tc.table_name = ${table} AND tc.constraint_type = 'FOREIGN KEY'`,
      );
      const defs = (await indexes(table)).map((i) => i.indexdef);
      for (const fk of fks) {
        expect(defs.some((d) => new RegExp(`\\(${fk.column_name}[,)]`).test(d))).toBe(true);
      }
    }
  });
});
