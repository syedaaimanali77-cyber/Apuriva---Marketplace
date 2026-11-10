/**
 * Spec 038 §4 "Migration" — that `0033` did what §4 says, and that its `_down.sql` reverses exactly
 * that. UP is verified against the LIVE test database the harness migrated; DOWN by reading the file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable } from './moderation-test-support';

const dbReachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0033_add_admin_moderation_fraud.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0033_add_admin_moderation_fraud_down.sql'), 'utf8');
const JOURNAL = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };

function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

afterAll(async () => {
  await getPool().end();
});

describe('migration 0033 — file-level guarantees (spec 038 §4)', () => {
  it('is the next journal entry after 0032 and has a hand-written down file', () => {
    // Position-based, not "last": later specs append migrations after 0033 (spec 039 added 0034 —
    // this one assertion change was approved by the product owner during spec 039).
    const at = JOURNAL.entries.findIndex((e) => e.tag === '0033_add_admin_moderation_fraud');
    expect(JOURNAL.entries[at]).toMatchObject({ idx: 33, tag: '0033_add_admin_moderation_fraud' });
    expect(JOURNAL.entries[at - 1]!.tag).toBe('0032_extend_ai_tool_calls');
  });

  it('creates exactly the three spec 038 tables, no jsonb, no money, and never touches the baseline', () => {
    const creates = [...statements(UP).matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
    expect(creates.sort()).toEqual(['fraud_signals', 'moderation_actions', 'moderation_appeals']);
    expect(statements(UP)).not.toMatch(/jsonb|_minor_units|numeric/i);
    expect(statements(UP)).not.toMatch(/0001_baseline_schema/);
    expect(statements(UP)).not.toMatch(/^\s*UPDATE\b/im); // no backfill: no row of any table is rewritten
  });

  it('adds NO foreign key to spec 030 safety_reports (OQ-4)', () => {
    expect(statements(UP)).not.toMatch(/ALTER TABLE "safety_reports"/);
  });

  it('the down file drops the three tables, restores the context vocabulary, and removes only this spec permissions', () => {
    const down = statements(DOWN);
    for (const table of ['moderation_appeals', 'moderation_actions', 'fraud_signals']) expect(down).toContain(`DROP TABLE IF EXISTS "${table}"`);
    const restored = down.split('\n').filter((line) => line.includes('ADD CONSTRAINT "file_assets_context_type_ck"'));
    expect(restored).toHaveLength(1);
    expect(restored[0]).not.toContain('moderation_evidence');
    expect(restored[0]).toContain('support_attachment');
    expect(down).toMatch(/DELETE FROM "permissions" WHERE "resource" = 'moderation'/);
    expect(down).toMatch(/DELETE FROM "permissions" WHERE "resource" = 'fraud_signals'/);
    expect(down).not.toMatch(/admin_role_assignments|DELETE FROM "roles"/);
  });
});

describe.skipIf(!dbReachable)('migration 0033 — live schema (spec 038 §4)', () => {
  it('the three tables exist with their key constraints', async () => {
    const rows = await queryRows<{ conname: string }>(
      getDb(),
      sql`SELECT conname FROM pg_constraint WHERE conname IN (
            'moderation_actions_approval_pairing_ck', 'moderation_actions_scope_target_ck', 'moderation_actions_reversal_pairing_ck',
            'moderation_actions_initiated_by_admin_id_admin_profiles_id_fk', 'fraud_signals_triage_pairing_ck', 'moderation_appeals_decision_pairing_ck')`,
    );
    expect(rows.map((r) => r.conname).sort()).toHaveLength(6);
  });

  it('the file context vocabulary admits moderation_evidence and keeps every earlier value', async () => {
    const [row] = await queryRows<{ def: string }>(getDb(), sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'file_assets_context_type_ck'`);
    for (const value of ['moderation_evidence', 'safety_evidence', 'support_attachment', 'review_media']) expect(row!.def).toContain(value);
  });

  // Scoped to spec 038's own eleven (resource, action) pairs: spec 009's suites seed unrelated
  // `moderation/*` fixture actions (e.g. `permanent_ban`) into the same shared test database.
  const SPEC_038_PAIRS = sql`(p.resource, p.action) IN (
    ('moderation','read'), ('moderation','warn'), ('moderation','restrict'), ('moderation','suspend'), ('moderation','ban'),
    ('moderation','intervene_booking'), ('moderation','freeze_payout'), ('moderation','reverse'), ('moderation','review_appeal'),
    ('fraud_signals','read'), ('fraud_signals','triage'))`;

  it('seeds the eleven §3.9 permission actions and nothing for unrelated roles', async () => {
    const rows = await queryRows<{ resource: string; action: string }>(
      getDb(),
      sql`SELECT DISTINCT p.resource, p.action FROM permissions p WHERE ${SPEC_038_PAIRS}`,
    );
    expect(rows).toHaveLength(11);
    const [none] = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM permissions p JOIN roles r ON r.id = p.role_id
           WHERE ${SPEC_038_PAIRS} AND r.name IN ('support_admin','content_admin','analytics_admin')`,
    );
    expect(none!.n).toBe(0);
  });
});
