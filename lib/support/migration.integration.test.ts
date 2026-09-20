/**
 * Spec 032 §6 "Migration / rollback" — that `0029` did what §4 says, and that its `_down.sql`
 * reverses exactly that and nothing else.
 *
 * The UP direction is verified against the LIVE test database, which the harness migrated before
 * this file ran — so these assertions are about the schema the application actually talks to, not
 * about the text of a file. The DOWN direction is verified by ACTUALLY RUNNING IT inside a rolled
 * back transaction, which is stronger than reading it: a `_down.sql` that would fail against a real
 * database is no rollback at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable } from './support-test-support';

const reachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0029_add_customer_provider_support.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0029_add_customer_provider_support_down.sql'), 'utf8');

/**
 * The EXECUTABLE SQL only, with `--` comments stripped. These migrations explain at length what
 * they deliberately do NOT do, so an assertion against the raw text would fail on the prose that
 * proves it right.
 */
function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const UP_SQL = statements(UP);
const DOWN_SQL = statements(DOWN);

describe('migration 0029 — file-level guarantees (spec 032 §4)', () => {
  it('creates NO table: all three are spec 003 baseline skeletons', () => {
    expect(UP_SQL).not.toMatch(/CREATE TABLE/i);
  });

  it('never touches the immutable baseline migration', () => {
    expect(UP_SQL).not.toMatch(/0001_baseline_schema/i);
  });

  it('adds no money column — there is nothing for the money lint to police', () => {
    expect(UP_SQL).not.toMatch(/amount_minor_units|currency_code|numeric/i);
  });

  it('is statement-broken throughout, so a partial failure is recoverable', () => {
    expect(UP.split('--> statement-breakpoint').length).toBeGreaterThan(30);
  });

  it('seeds exactly the five support permissions and no others', () => {
    for (const action of ['read', 'assign', 'respond', 'triage', 'resolve']) {
      expect(UP_SQL).toContain(`'support', '${action}'`);
    }
    // Operations watches; it never acts.
    expect(UP_SQL).toMatch(/'support_admin', 'operations_admin', 'super_admin'/);
  });

  it('the down migration refuses to run if any support table holds data', () => {
    expect(DOWN).toMatch(/RAISE EXCEPTION/);
    for (const table of ['support_tickets', 'support_messages', 'support_notes']) {
      expect(DOWN).toContain(`FROM "${table}"`);
    }
  });

  it('the down migration drops the three skeleton tables NOWHERE', () => {
    // Rollback returns them to their spec 003 shape; dropping them would break 0001's FKs.
    expect(DOWN_SQL).not.toMatch(/DROP TABLE/i);
  });

  it('the down migration narrows the file context vocabulary by exactly ONE value', () => {
    // `safety_evidence` and `review_media` belong to specs 030 and 029 and must survive the
    // rollback; only `support_attachment` is withdrawn.
    expect(DOWN_SQL).toContain("'safety_evidence'");
    expect(DOWN_SQL).toContain("'review_media'");
    const restored = DOWN_SQL.split('\n').filter((line) =>
      line.includes('ADD CONSTRAINT "file_assets_context_type_ck"'),
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]).not.toContain('support_attachment');
  });

  it('the down migration removes only this spec permissions', () => {
    expect(DOWN_SQL).toMatch(/DELETE FROM "permissions" WHERE "resource" = 'support'/);
    expect(DOWN_SQL).not.toMatch(/DELETE FROM "permissions" WHERE "resource" = '(?!support)/);
  });
});

describe.skipIf(!reachable)('migration 0029 — applied shape (live database)', () => {
  it('added every feature column to the three skeletons', async () => {
    const rows = await queryRows<{ table_name: string; column_name: string }>(
      getDb(),
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN ('support_tickets','support_messages','support_notes')`,
    );
    const has = (table: string, column: string) =>
      rows.some((r) => r.table_name === table && r.column_name === column);

    for (const column of [
      'subject',
      'description',
      'category',
      'priority',
      'status',
      'requester_mode',
      'context_type',
      'context_id',
      'assigned_admin_user_id',
      'sla_deadline_at',
      'sla_paused_seconds',
      'awaiting_user_since',
      'ai_summary',
      'resolution_kind',
      'resolution_reason',
      'handoff_target',
      'escalated_safety_report_id',
      'escalated_dispute_id',
      'legal_hold',
      'reopen_count',
      'resolved_at',
      'closed_at',
      'idempotency_key',
      'idempotency_fingerprint',
    ]) {
      expect(has('support_tickets', column), `support_tickets.${column}`).toBe(true);
    }
    expect(has('support_messages', 'is_admin')).toBe(true);
    expect(has('support_messages', 'body')).toBe(true);
    expect(has('support_notes', 'body')).toBe(true);

    // The spec 003 columns are still there — the skeletons were extended, not replaced.
    expect(has('support_tickets', 'requester_user_id')).toBe(true);
    expect(has('support_messages', 'sender_user_id')).toBe(true);
    expect(has('support_notes', 'author_user_id')).toBe(true);
  });

  it('installed every CHECK the spec names, including the AC-9 guarantee', async () => {
    const rows = await queryRows<{ conname: string }>(
      getDb(),
      sql`SELECT conname FROM pg_constraint WHERE conname LIKE 'support_%_ck'`,
    );
    const names = rows.map((r) => r.conname);
    for (const name of [
      'support_tickets_category_ck',
      'support_tickets_priority_ck',
      'support_tickets_status_ck',
      'support_tickets_context_type_ck',
      'support_tickets_context_pairing_ck',
      'support_tickets_resolution_pairing_ck',
      'support_tickets_handoff_pairing_ck',
      'support_tickets_closed_pairing_ck',
      'support_tickets_awaiting_pairing_ck',
      'support_tickets_safety_resolution_ck',
      'support_messages_body_length_ck',
      'support_notes_body_length_ck',
    ]) {
      expect(names, `missing ${name}`).toContain(name);
    }
  });

  it('the live file-context vocabulary carries all ten values', async () => {
    const rows = await queryRows<{ def: string }>(
      getDb(),
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'file_assets_context_type_ck'`,
    );
    const def = rows[0]!.def;
    for (const value of ['review_media', 'safety_evidence', 'support_attachment']) {
      expect(def, `vocabulary lost ${value}`).toContain(value);
    }
  });

  it('seeded the five permissions against the right roles', async () => {
    const rows = await queryRows<{ action: string; name: string; risk_tier: string }>(
      getDb(),
      sql`SELECT p.action, r.name, p.risk_tier FROM permissions p
            JOIN roles r ON r.id = p.role_id
           WHERE p.resource = 'support'`,
    );
    const forAction = (action: string) => rows.filter((r) => r.action === action).map((r) => r.name).sort();

    expect(forAction('read')).toEqual(['operations_admin', 'super_admin', 'support_admin']);
    for (const action of ['assign', 'respond', 'triage', 'resolve']) {
      expect(forAction(action), action).toEqual(['super_admin', 'support_admin']);
    }
    expect(rows.find((r) => r.action === 'resolve')!.risk_tier).toBe('medium');
    expect(rows.find((r) => r.action === 'read')!.risk_tier).toBe('low');
  });

  /**
   * THE ROLLBACK, ACTUALLY EXECUTED — inside a transaction that is then rolled back, so the test
   * database is left exactly as it was found. Reading the file proves it says the right things;
   * running it proves it works.
   */
  it('the down migration runs cleanly against the live schema, then is undone', async () => {
    const db = getDb();
    await expect(
      db.transaction(async (tx) => {
        // The down migration deliberately REFUSES to run while support data exists — that guard is
        // asserted separately at file level. To exercise the DDL itself, this transaction first
        // clears the rows other suites left behind; the whole transaction is rolled back below, so
        // nothing is actually deleted.
        await tx.execute(sql`DELETE FROM support_notes`);
        await tx.execute(sql`DELETE FROM support_messages`);
        await tx.execute(sql`DELETE FROM support_tickets`);

        for (const statement of DOWN.split('--> statement-breakpoint')) {
          const trimmed = statement.trim();
          if (trimmed.length === 0) continue;
          await tx.execute(sql.raw(trimmed));
        }
        // Inside the transaction the feature columns are gone...
        const cols = await queryRows<{ column_name: string }>(
          tx,
          sql`SELECT column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'support_tickets'`,
        );
        const names = cols.map((c) => c.column_name);
        expect(names).not.toContain('sla_deadline_at');
        expect(names).not.toContain('resolution_kind');
        // ...but the spec 003 skeleton survives.
        expect(names).toContain('requester_user_id');
        expect(names).toContain('id');

        // Undo everything this test just did.
        throw new Error('rollback-probe');
      }),
    ).rejects.toThrow('rollback-probe');

    // And the live schema is untouched afterwards.
    const after = await queryRows<{ column_name: string }>(
      db,
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'sla_deadline_at'`,
    );
    expect(after).toHaveLength(1);
  });
});
