import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { ANALYTICS_EVENT_TYPES } from '@/lib/types/analytics';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0035_implement_analytics_events.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0035_implement_analytics_events_down.sql'), 'utf8');

describe('migration 0035 — file-level guarantees (spec 040 §4)', () => {
  it('is the next journal entry after 0034 and the down file is not journalled', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tags = journal.entries.map((e) => e.tag);
    const index = tags.indexOf('0035_implement_analytics_events');
    expect(index).toBe(tags.indexOf('0034_implement_audit_log') + 1);
    expect(journal.entries[index]!.idx).toBe(35);
    expect(tags).not.toContain('0035_implement_analytics_events_down');
  });

  it('ALTERS the spec 003 stub — never re-creates it — and backfills nothing', () => {
    expect(UP).toMatch(/ALTER TABLE "analytics_events"/);
    expect(UP).not.toMatch(/CREATE TABLE/);
    expect(UP).not.toMatch(/INSERT INTO "?analytics_events/);
    for (const type of ANALYTICS_EVENT_TYPES) expect(UP).toContain(`'${type}'`);
  });

  it('seeds exactly the three §3.7 permissions for the existing roles', () => {
    expect(UP).toMatch(/\('analytics', 'read', 'low'\)[\s\S]*'analytics_admin', 'super_admin'/);
    expect(UP).toMatch(/\('analytics', 'read_revenue', 'low'\)[\s\S]*'analytics_admin', 'finance_admin', 'super_admin'/);
    expect(UP).toMatch(/\('analytics', 'read_provider_performance', 'low'\)[\s\S]*'analytics_admin', 'operations_admin', 'super_admin'/);
    expect(UP).not.toMatch(/INSERT INTO "roles"/);
  });

  it('the down file reverses exactly what 0035 added', () => {
    expect(DOWN).toContain(`DELETE FROM "permissions" WHERE "resource" = 'analytics' AND "action" IN ('read','read_revenue','read_provider_performance');`);
    for (const index of ['analytics_events_occurred_idx', 'analytics_events_type_occurred_idx']) expect(DOWN).toContain(`DROP INDEX IF EXISTS "${index}"`);
    for (const constraint of ['analytics_events_properties_object_ck', 'analytics_events_event_type_ck']) {
      expect(DOWN).toContain(`DROP CONSTRAINT IF EXISTS "${constraint}"`);
    }
    for (const column of ['properties', 'occurred_at', 'event_type']) expect(DOWN).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    expect(DOWN).not.toMatch(/DROP TABLE|actor_user_id/);
  });
});

describe.skipIf(!dbReachable)('migration 0035 — live schema (spec 040 §4)', () => {
  it('keeps baseColumns and actor_user_id; adds event_type, occurred_at and properties', async () => {
    const rows = await queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
      getDb(),
      sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'analytics_events'`,
    );
    const col = Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}/${r.is_nullable}`]));
    expect(col).toEqual({
      id: 'uuid/NO',
      created_at: 'timestamp with time zone/NO',
      updated_at: 'timestamp with time zone/NO',
      version: 'integer/NO',
      actor_user_id: 'uuid/YES',
      event_type: 'text/NO',
      occurred_at: 'timestamp with time zone/NO',
      properties: 'jsonb/NO',
    });
  });

  it('has the two new indexes next to the actor index', async () => {
    const { rows } = await getPool().query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'analytics_events'");
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['analytics_events_actor_user_id_idx', 'analytics_events_type_occurred_idx', 'analytics_events_occurred_idx']),
    );
  });

  it('the CHECKs reject an unknown event type and non-object properties', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query("INSERT INTO analytics_events (event_type, occurred_at) VALUES ('page_view', now())"),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await expect(
        client.query("INSERT INTO analytics_events (event_type, occurred_at, properties) VALUES ('search_performed', now(), '[]')"),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('seeds analytics permissions for exactly the §3.7 roles', async () => {
    const { rows } = await getPool().query<{ name: string; action: string; risk_tier: string }>(
      `SELECT r.name, p.action, p.risk_tier FROM permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.resource = 'analytics' ORDER BY p.action, r.name`,
    );
    // Seeded pristine grants; no other suite grants analytics permissions.
    expect(rows.map((r) => `${r.action}:${r.name}:${r.risk_tier}`)).toEqual([
      'read:analytics_admin:low',
      'read:super_admin:low',
      'read_provider_performance:analytics_admin:low',
      'read_provider_performance:operations_admin:low',
      'read_provider_performance:super_admin:low',
      'read_revenue:analytics_admin:low',
      'read_revenue:finance_admin:low',
      'read_revenue:super_admin:low',
    ]);
  });
});
