import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from './index';
import { isDatabaseReachable } from './test-support';

/**
 * Spec 003 AC-6: `UPDATE ... SET version = version + 1, ... WHERE id = $1 AND version = $2`;
 * the write that lands first succeeds and increments version; a second write racing against
 * the same stale version matches zero rows, which the application must treat as an explicit
 * concurrency-conflict error, never a silent lost update. Skips (not fails) if no DB is reachable.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('optimistic concurrency (integration, spec 003 AC-6)', () => {
  const pool = getPool();
  let client: PoolClient;

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  it('a write against the current version succeeds and increments version', async () => {
    const { rows } = await client.query<{ id: string; version: number }>(
      'INSERT INTO categories DEFAULT VALUES RETURNING id, version',
    );
    const { id, version } = rows[0]!;
    expect(version).toBe(1);

    const result = await client.query('UPDATE categories SET version = version + 1 WHERE id = $1 AND version = $2', [
      id,
      version,
    ]);
    expect(result.rowCount).toBe(1);

    const { rows: after } = await client.query<{ version: number }>('SELECT version FROM categories WHERE id = $1', [id]);
    expect(after[0]!.version).toBe(2);
  });

  it('a second write against the now-stale version matches zero rows — a concurrency conflict, not a silent overwrite', async () => {
    const { rows } = await client.query<{ id: string; version: number }>(
      'INSERT INTO categories DEFAULT VALUES RETURNING id, version',
    );
    const { id, version: staleVersion } = rows[0]!;

    // First writer succeeds and moves version 1 -> 2.
    const first = await client.query('UPDATE categories SET version = version + 1 WHERE id = $1 AND version = $2', [
      id,
      staleVersion,
    ]);
    expect(first.rowCount).toBe(1);

    // Second writer retries with the same (now stale) version it originally read.
    const second = await client.query('UPDATE categories SET version = version + 1 WHERE id = $1 AND version = $2', [
      id,
      staleVersion,
    ]);
    expect(second.rowCount).toBe(0);

    const { rows: after } = await client.query<{ version: number }>('SELECT version FROM categories WHERE id = $1', [id]);
    expect(after[0]!.version).toBe(2); // the stale writer's increment never landed
  });
});
