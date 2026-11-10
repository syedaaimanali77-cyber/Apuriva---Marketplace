/**
 * Spec 036 §4 "Migration" — `0032` did exactly what §4 says, and its `_down.sql` reverses exactly that.
 * UP is checked against the LIVE test database (migrated by the harness); DOWN is ACTUALLY RUN inside
 * a transaction that is then rolled back — the approach specs 032, 034 and 035 established.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable, seedConversation, seedPendingAction } from './mcp-tools-test-support';

const reachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0032_extend_ai_tool_calls.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0032_extend_ai_tool_calls_down.sql'), 'utf8');
const JOURNAL = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };

function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const UP_SQL = statements(UP);
const DOWN_SQL = statements(DOWN);
const ADDED = ['idempotency_key', 'input_params', 'output_summary', 'error_code', 'retried_from_call_id'];

describe('migration 0032 — file-level guarantees (spec 036 §4)', () => {
  it('is the next migration after 0031 and is journaled, while the down migration is not', () => {
    const tags = JOURNAL.entries.map((entry) => entry.tag);
    expect(tags).toContain('0032_extend_ai_tool_calls');
    expect(tags).not.toContain('0032_extend_ai_tool_calls_down');
    expect(JOURNAL.entries.find((entry) => entry.tag === '0032_extend_ai_tool_calls')!.idx).toBe(32);
  });

  it('creates no table and alters only ai_tool_calls — never spec 034’s or spec 035’s tables', () => {
    expect(UP_SQL).not.toMatch(/CREATE TABLE/i);
    const altered = [...UP_SQL.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((match) => match[1]);
    expect(new Set(altered)).toEqual(new Set(['ai_tool_calls']));
    for (const source of [UP_SQL, DOWN_SQL]) {
      expect(source).not.toMatch(/"ai_actions"|"ai_conversations"|"ai_messages"|"mcp_confirmations"|"mcp_confirmation_parameters"/);
      expect(source).not.toMatch(/0001_baseline_schema/);
    }
  });

  it('is additive and non-destructive: the NOT NULL column gets a temporary default, nothing is dropped', () => {
    expect(UP_SQL).not.toMatch(/DROP (TABLE|COLUMN)/i);
    expect(UP_SQL).toMatch(/ADD COLUMN "input_params" jsonb DEFAULT '\{\}'::jsonb NOT NULL/);
    expect(UP_SQL).toMatch(/ALTER COLUMN "input_params" DROP DEFAULT/);
  });

  it('indexes and RESTRICTs the new self-reference, and adds no float money or naive timestamp', () => {
    expect(UP_SQL).toContain('"ai_tool_calls_retried_from_call_id_idx"');
    expect(UP_SQL).toMatch(/ON DELETE restrict/);
    expect(UP_SQL).not.toMatch(/ON DELETE (cascade|set null)/i);
    expect(UP_SQL).not.toMatch(/numeric|real|double precision|timestamp/i);
  });

  it('the down migration refuses once a tool call exists and reverses only the five added columns', () => {
    expect(DOWN).toMatch(/RAISE EXCEPTION/);
    expect(DOWN).toContain('FROM "ai_tool_calls"');
    for (const column of ADDED) expect(DOWN_SQL).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    expect(DOWN_SQL).not.toMatch(/DROP TABLE/i);
    expect(DOWN_SQL).not.toMatch(/"ai_action_id"/);
  });
});

describe.skipIf(!reachable)('migration 0032 — applied shape (live database)', () => {
  async function columns() {
    return queryRows<{ column_name: string; data_type: string; is_nullable: string }>(
      getDb(),
      sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ai_tool_calls'`,
    );
  }

  it('added the five columns with the §4 types and nullability, keeping the baseline ones', async () => {
    const rows = await columns();
    const col = (name: string) => rows.find((row) => row.column_name === name);
    for (const name of ['id', 'created_at', 'updated_at', 'version', 'ai_action_id']) expect(col(name), name).toBeDefined();
    expect(col('idempotency_key')).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(col('input_params')).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(col('output_summary')).toMatchObject({ data_type: 'jsonb', is_nullable: 'YES' });
    expect(col('error_code')).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
    expect(col('retried_from_call_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'YES' });
  });

  it('the down migration REFUSES while a tool call exists — the guard, exercised for real', async () => {
    const session = await registerAndLogin();
    const aiActionId = await seedPendingAction(await seedConversation(session.userId), 'get_booking', 'low');
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO ai_tool_calls (ai_action_id, input_params) VALUES (${aiActionId}, '{}'::jsonb)`);
        await tx.execute(sql.raw(DOWN_SQL));
        throw new Error('the down migration dropped the columns while a tool call existed');
      }),
    ).rejects.toThrow(/Refusing to roll back 0032/);
  });

  it('the down migration actually runs on an empty table, inside a transaction that is then rolled back', async () => {
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM ai_tool_calls`);
        await tx.execute(sql.raw(DOWN_SQL));
        const remaining = await queryRows<{ column_name: string }>(
          tx as unknown as Parameters<typeof queryRows>[0],
          sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_tool_calls'`,
        );
        expect(remaining.map((row) => row.column_name).sort()).toEqual(['ai_action_id', 'created_at', 'id', 'updated_at', 'version']);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect((await columns()).map((row) => row.column_name)).toEqual(expect.arrayContaining(ADDED));
  });
});
