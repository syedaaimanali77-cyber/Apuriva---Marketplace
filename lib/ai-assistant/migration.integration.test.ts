/**
 * Spec 034 §4 "Migration" — that `0030` did what §4 says, and that its `_down.sql` reverses exactly
 * that and nothing else. UP is checked against the LIVE test database (migrated by the harness); DOWN
 * is ACTUALLY RUN inside a transaction that is then rolled back — the spec 032 approach.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isDatabaseReachable } from './ai-assistant-test-support';

const reachable = await isDatabaseReachable();
const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const UP = readFileSync(join(DRIZZLE, '0030_add_ai_conversation_memory.sql'), 'utf8');
const DOWN = readFileSync(join(DRIZZLE, '0030_add_ai_conversation_memory_down.sql'), 'utf8');
const JOURNAL = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };

/** The executable SQL only — these files explain at length what they deliberately do NOT do. */
function statements(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const UP_SQL = statements(UP);
const DOWN_SQL = statements(DOWN);

describe('migration 0030 — file-level guarantees (spec 034 §4)', () => {
  it('creates NO table: all four AI tables are spec 003 baseline skeletons', () => {
    expect(UP_SQL).not.toMatch(/CREATE TABLE/i);
  });

  it('never touches ai_tool_calls (spec 036) or the immutable baseline migration', () => {
    expect(UP_SQL).not.toMatch(/ai_tool_calls/);
    expect(DOWN_SQL).not.toMatch(/ai_tool_calls/);
    expect(UP_SQL).not.toMatch(/0001_baseline_schema/);
  });

  it('adds no money column', () => {
    expect(UP_SQL).not.toMatch(/amount_minor_units|currency_code|numeric/i);
  });

  it('limits memory keys to the closed allow-list and excludes restricted from risk tiers', () => {
    expect(UP_SQL).toContain(`CHECK ("key" in ('preferred_category','preferred_area','language'))`);
    expect(UP_SQL).not.toMatch(/characteristic|communication/i);
    expect(UP_SQL).toContain(`CHECK ("risk_tier" in ('low','medium','high'))`);
    expect(UP_SQL).not.toMatch(/'restricted'/);
  });

  it('is journaled, while the down migration is not', () => {
    const tags = JOURNAL.entries.map((e) => e.tag);
    expect(tags).toContain('0030_add_ai_conversation_memory');
    expect(tags).not.toContain('0030_add_ai_conversation_memory_down');
  });

  it('the down migration refuses to run while any transcript, memory or activity row exists', () => {
    expect(DOWN).toMatch(/RAISE EXCEPTION/);
    for (const table of ['ai_messages', 'ai_memories', 'ai_actions']) expect(DOWN).toContain(`FROM "${table}"`);
  });

  it('the down migration drops no table', () => {
    expect(DOWN_SQL).not.toMatch(/DROP TABLE/i);
  });
});

describe.skipIf(!reachable)('migration 0030 — applied shape (live database)', () => {
  it('added every feature column, keeping the spec 003 columns', async () => {
    const rows = await queryRows<{ table_name: string; column_name: string }>(
      getDb(),
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name IN ('ai_conversations','ai_messages','ai_memories','ai_actions','users')`,
    );
    const has = (table: string, column: string) => rows.some((r) => r.table_name === table && r.column_name === column);
    const expected: Record<string, string[]> = {
      ai_conversations: ['user_id', 'deleted_at', 'idempotency_key', 'idempotency_fingerprint'],
      ai_messages: ['ai_conversation_id', 'role', 'body', 'idempotency_key', 'idempotency_fingerprint'],
      ai_memories: ['user_id', 'key', 'value'],
      ai_actions: [
        'ai_conversation_id',
        'action_type',
        'risk_tier',
        'required_confirmation',
        'result',
        'reversible',
        'related_entity_type',
        'related_entity_id',
        'idempotency_key',
        'idempotency_fingerprint',
      ],
      users: ['ai_proactive_suggestions_enabled'],
    };
    for (const [table, columns] of Object.entries(expected)) {
      for (const column of columns) expect(has(table, column), `${table}.${column}`).toBe(true);
    }
    // No temporary flag and no plain-text label: neither is stored (§3.11, §4).
    expect(has('ai_conversations', 'is_temporary')).toBe(false);
    expect(has('ai_actions', 'action_label')).toBe(false);
  });

  it('installed every CHECK and unique index the spec names', async () => {
    const constraints = (await queryRows<{ conname: string }>(getDb(), sql`SELECT conname FROM pg_constraint WHERE conname LIKE 'ai_%_ck'`)).map(
      (r) => r.conname,
    );
    for (const name of [
      'ai_messages_role_ck',
      'ai_messages_idempotency_ck',
      'ai_memories_key_ck',
      'ai_actions_risk_tier_ck',
      'ai_actions_result_ck',
      'ai_actions_related_entity_type_ck',
      'ai_actions_related_pair_ck',
      'ai_actions_idempotency_pair_ck',
    ]) {
      expect(constraints, `missing ${name}`).toContain(name);
    }
    const indexes = (await queryRows<{ indexname: string }>(getDb(), sql`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'ai_%'`)).map(
      (r) => r.indexname,
    );
    for (const name of [
      'ai_memories_user_key_uq',
      'ai_conversations_user_idempotency_key_uq',
      'ai_messages_conversation_idempotency_key_uq',
      'ai_actions_conversation_idempotency_key_uq',
      'ai_conversations_user_updated_at_idx',
      'ai_messages_conversation_created_at_id_idx',
      'ai_actions_conversation_created_at_idx',
    ]) {
      expect(indexes, `missing ${name}`).toContain(name);
    }
  });

  it('the database refuses a restricted action row even if application code tried (AC-7)', async () => {
    await expect(
      getDb().transaction(async (tx) => {
        const [user] = await queryRows<{ id: string }>(tx, sql`INSERT INTO users DEFAULT VALUES RETURNING id`);
        const [conversation] = await queryRows<{ id: string }>(
          tx,
          sql`INSERT INTO ai_conversations (user_id, idempotency_key, idempotency_fingerprint) VALUES (${user!.id}, 'k', 'f') RETURNING id`,
        );
        await tx.execute(
          sql`INSERT INTO ai_actions (ai_conversation_id, action_type, risk_tier, required_confirmation)
              VALUES (${conversation!.id}, 'ban_user', 'restricted', true)`,
        );
      }),
    ).rejects.toThrow();
  });

  it('the down migration runs cleanly against the live schema, then is undone', async () => {
    const db = getDb();
    await expect(
      db.transaction(async (tx) => {
        // The down migration refuses to run while AI data exists (asserted at file level). To exercise
        // the DDL itself this transaction clears other suites' rows first; it is all rolled back.
        await tx.execute(sql`DELETE FROM ai_tool_calls`);
        await tx.execute(sql`DELETE FROM ai_actions`);
        await tx.execute(sql`DELETE FROM ai_messages`);
        await tx.execute(sql`DELETE FROM ai_memories`);
        for (const statement of DOWN.split('--> statement-breakpoint')) {
          const trimmed = statement.trim();
          if (trimmed.length > 0) await tx.execute(sql.raw(trimmed));
        }
        const cols = await queryRows<{ table_name: string; column_name: string }>(
          tx,
          sql`SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name IN ('ai_actions','ai_memories','users')`,
        );
        const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
        expect(names).not.toContain('ai_actions.risk_tier');
        expect(names).not.toContain('ai_memories.key');
        expect(names).not.toContain('users.ai_proactive_suggestions_enabled');
        // The spec 003 skeletons survive.
        expect(names).toContain('ai_actions.ai_conversation_id');
        expect(names).toContain('ai_memories.user_id');
        throw new Error('rollback-probe');
      }),
    ).rejects.toThrow('rollback-probe');

    const after = await queryRows<{ column_name: string }>(
      db,
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ai_memories' AND column_name = 'key'`,
    );
    expect(after).toHaveLength(1);
  });
});
