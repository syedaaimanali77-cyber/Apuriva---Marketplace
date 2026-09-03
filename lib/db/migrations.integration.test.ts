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

  it('creates all 77 baseline tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(rows.length).toBe(77);
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
