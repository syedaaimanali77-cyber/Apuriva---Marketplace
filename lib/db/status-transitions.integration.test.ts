import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from './index';
import { isDatabaseReachable, seedMinimalRequest } from './test-support';

/**
 * Spec 003 AC-3: PostgreSQL is the final enforcement layer for status transitions — a DB
 * trigger rejects a status update whose (from, to) pair isn't in that entity's transition
 * table, independent of the application layer. Every test runs inside a transaction rolled
 * back in afterEach, so nothing here persists (the transition tables stay empty for real
 * later specs to populate). Skips (not fails) if no DB is reachable.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('status-transition DB trigger (integration, spec 003 AC-3)', () => {
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

  it('rejects a transition absent from requests_status_transitions', async () => {
    const requestId = await seedMinimalRequest(client, 'draft');

    await expect(client.query('UPDATE requests SET status = $1 WHERE id = $2', ['submitted', requestId])).rejects.toThrow(
      /Invalid requests status transition/,
    );
  });

  it('allows a transition once it is present in requests_status_transitions', async () => {
    const requestId = await seedMinimalRequest(client, 'draft');
    await client.query('INSERT INTO requests_status_transitions (from_status, to_status) VALUES ($1, $2)', [
      'draft',
      'submitted',
    ]);

    await client.query('UPDATE requests SET status = $1 WHERE id = $2', ['submitted', requestId]);

    const { rows } = await client.query<{ status: string }>('SELECT status FROM requests WHERE id = $1', [requestId]);
    expect(rows[0]!.status).toBe('submitted');
  });

  it('a no-op update (status unchanged) is always allowed, even with an empty transition table', async () => {
    const requestId = await seedMinimalRequest(client, 'draft');

    await expect(
      client.query('UPDATE requests SET status = $1, version = version + 1 WHERE id = $2', ['draft', requestId]),
    ).resolves.toBeDefined();
  });

  it('enforcement is independent of the application layer — a raw UPDATE with no app-level pre-check is still rejected', async () => {
    const requestId = await seedMinimalRequest(client, 'draft');

    // No Drizzle/application pre-validation at all here — just a raw SQL UPDATE — proving the
    // DB trigger, not app code, is what actually blocks the invalid transition (AC-3).
    let rejected = false;
    try {
      await client.query('UPDATE requests SET status = $1 WHERE id = $2', ['completed', requestId]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
