import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, csrfCookieFrom, sessionCookieFrom } from '@/app/api/v1/auth/test-support';
import { enterDemoEnvironment, isDatabaseReachable } from '@/lib/demo/demo-test-support';
import { BASE, loginAs, type DemoVisitor } from '../demo-route-test-support';
import { POST } from './route';

const dbReachable = await isDatabaseReachable();

type Fingerprint = Map<string, { hash: string }>;

/**
 * A fingerprint of EVERY row of EVERY table with an `id`: `table:id → md5(row)`. The reset may only insert,
 * plus revoke the caller's own session (spec 045 AC-5).
 */
async function fingerprint(): Promise<Fingerprint> {
  const tables = await queryRows<{ table_name: string }>(
    getDb(),
    sql`SELECT c.table_name FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
         WHERE c.table_schema = 'public' AND c.column_name = 'id' AND t.table_type = 'BASE TABLE'`,
  );
  const rows = new Map<string, { hash: string }>();
  for (const { table_name } of tables) {
    const found = await queryRows<{ id: string; hash: string }>(
      getDb(),
      sql`SELECT id::text AS id, md5(t::text) AS hash FROM ${sql.identifier(table_name)} t`,
    );
    for (const row of found) rows.set(`${table_name}:${row.id}`, { hash: row.hash });
  }
  return rows;
}

/** The current `xmin` (the writing transaction) of each changed row, to attribute every change. */
async function writerOf(key: string): Promise<string | null> {
  const [table, id] = key.split(':') as [string, string];
  const [row] = await queryRows<{ xmin: string }>(getDb(), sql`SELECT xmin::text AS xmin FROM ${sql.identifier(table)} WHERE id::text = ${id}`);
  return row?.xmin ?? null;
}

/** Every row of one demo set, across the tables the seed writes, hashed — "byte-identical" in AC-5's words. */
async function setRows(userId: string): Promise<string[]> {
  const rows = await queryRows<{ hash: string }>(
    getDb(),
    sql`WITH set_users AS (SELECT id FROM users WHERE demo_set_id = (SELECT demo_set_id FROM users WHERE id = ${userId})),
             cps AS (SELECT id FROM customer_profiles WHERE user_id IN (SELECT id FROM set_users)),
             pps AS (SELECT id FROM provider_profiles WHERE user_id IN (SELECT id FROM set_users)),
             bks AS (SELECT id FROM bookings WHERE customer_profile_id IN (SELECT id FROM cps))
        SELECT md5(t::text) AS hash FROM users t WHERE id IN (SELECT id FROM set_users)
        UNION ALL SELECT md5(t::text) FROM customer_profiles t WHERE id IN (SELECT id FROM cps)
        UNION ALL SELECT md5(t::text) FROM provider_profiles t WHERE id IN (SELECT id FROM pps)
        UNION ALL SELECT md5(t::text) FROM requests t WHERE customer_profile_id IN (SELECT id FROM cps)
        UNION ALL SELECT md5(t::text) FROM offers t WHERE provider_profile_id IN (SELECT id FROM pps)
        UNION ALL SELECT md5(t::text) FROM bookings t WHERE id IN (SELECT id FROM bks)
        UNION ALL SELECT md5(t::text) FROM payments t WHERE booking_id IN (SELECT id FROM bks)
        UNION ALL SELECT md5(t::text) FROM refunds t WHERE booking_id IN (SELECT id FROM bks)
        UNION ALL SELECT md5(t::text) FROM reviews t WHERE booking_id IN (SELECT id FROM bks)
        UNION ALL SELECT md5(t::text) FROM notifications t WHERE recipient_user_id IN (SELECT id FROM set_users)
        ORDER BY 1`,
  );
  return rows.map((row) => row.hash);
}

function resetRequest(visitor: DemoVisitor): Request {
  const req = authenticatedRequest(`${BASE}/demo/reset`, visitor.sessionId, visitor.csrfToken, { method: 'POST', body: {} });
  req.headers.set('x-forwarded-for', '203.0.113.90');
  return req;
}

describe.skipIf(!dbReachable)('POST /api/v1/demo/reset (spec 045 D2, AC-5)', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = enterDemoEnvironment();
  });
  afterAll(() => restore?.());
  beforeEach(() => resetRateLimitState());

  it('provisions a NEW set for the same persona, revokes the caller’s session and replaces it, and changes no existing row', async () => {
    const visitor = await loginAs('provider', '203.0.113.81');
    const other = await loginAs('customer', '203.0.113.82');
    resetRateLimitState();

    const otherBefore = await setRows(other.userId);
    const before = await fingerprint();

    const res = (await POST(resetRequest(visitor))) as NextResponse;
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { userId: string; sessionId: string } };

    // A different persona user, of a different set, with the same persona; a fresh session in the cookies.
    expect(data.userId).not.toBe(visitor.userId);
    expect(sessionCookieFrom(res)).toBe(data.sessionId);
    expect(csrfCookieFrom(res)).toBeTruthy();
    const [sets] = await queryRows<{ old_set: string; new_set: string; new_is_provider: boolean; new_xmin: string }>(
      getDb(),
      sql`SELECT (SELECT demo_set_id FROM users WHERE id = ${visitor.userId}) AS old_set,
                 (SELECT demo_set_id FROM users WHERE id = ${data.userId}) AS new_set,
                 EXISTS (SELECT 1 FROM provider_profiles WHERE user_id = ${data.userId}) AS new_is_provider,
                 (SELECT xmin::text FROM users WHERE id = ${data.userId}) AS new_xmin`,
    );
    expect(sets!.new_set).not.toBe(sets!.old_set);
    expect(sets!.new_is_provider).toBe(true);

    // The old session is revoked through spec 005's normal path; nothing else of the caller's is touched.
    const [old] = await queryRows<{ revoked_at: Date | null; revoked_reason: string | null }>(
      getDb(),
      sql`SELECT revoked_at, revoked_reason FROM sessions WHERE id = ${visitor.sessionId}`,
    );
    expect(old!.revoked_at).not.toBeNull();
    expect(old!.revoked_reason).toBe('demo_reset');

    // AC-5: no pre-existing row is deleted, and none is updated by the reset. The only allowed change is the
    // caller's own session. Rows other test files update in parallel carry their own transaction ids; the
    // provisioning transaction's id (the new set's `xmin`) must appear on NO pre-existing row.
    const after = await fingerprint();
    const deleted = [...before.keys()].filter((key) => !after.has(key));
    expect(deleted).toEqual([]);
    const changed = [...before.entries()].filter(([key, value]) => after.get(key)!.hash !== value.hash).map(([key]) => key);
    const writtenByReset: string[] = [];
    for (const key of changed) {
      if (key === `sessions:${visitor.sessionId}`) continue;
      if ((await writerOf(key)) === sets!.new_xmin) writtenByReset.push(key);
    }
    expect(writtenByReset).toEqual([]);

    // The other visitor's set is byte-identical, and the caller's previous set still exists, unchanged.
    expect(await setRows(other.userId)).toEqual(otherBefore);
    const [previous] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM users WHERE demo_set_id = ${sets!.old_set}`);
    expect(previous!.n).toBeGreaterThan(0);
  }, 120_000);

  it('the replaced session no longer works: a second reset with it is 401', async () => {
    const visitor = await loginAs('customer', '203.0.113.83');
    resetRateLimitState();
    expect((await POST(resetRequest(visitor))).status).toBe(200);
    resetRateLimitState();
    expect((await POST(resetRequest(visitor))).status).toBe(401);
  }, 120_000);
});
