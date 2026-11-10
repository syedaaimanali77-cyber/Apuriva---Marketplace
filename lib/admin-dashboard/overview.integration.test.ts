import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { REQUEST_STATUSES } from '@/lib/db/schema';
import { seedMinimalRequest } from '@/lib/db/test-support';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/types/requests';
import {
  adminWithRole,
  insertSafetyReport,
  isDatabaseReachable,
  seedRealBooking,
  withSnapshot,
} from './admin-dashboard-test-support';
import {
  alertsFor,
  countActiveBookings,
  countActiveRequests,
  countOpenCriticalSafetyReports,
  criticalSafetyReportsMessage,
  getAdminOverview,
  revenueForUtcDay,
} from './overview';

const dbReachable = await isDatabaseReachable();

/** A UTC day no other test ever writes a capture into, so revenue sums on it are exact. */
const DAY = new Date('2091-03-15T12:00:00.000Z');
const IN_DAY = '2091-03-15T08:30:00.000Z';
const DAY_START = '2091-03-15T00:00:00.000Z';
const LAST_INSTANT_BEFORE = '2091-03-14T23:59:59.999Z';
const NEXT_DAY_START = '2091-03-16T00:00:00.000Z';

async function insertPayment(
  client: PoolClient,
  bookingId: string,
  input: { status: string; amount: number; currency: string; history: Array<{ to: string; at: string }> },
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payments (booking_id, status, charge_amount_minor_units, charge_currency_code, provider_name,
                           idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, $3, $4, 'sandbox', $5, 'fp') RETURNING id`,
    [bookingId, input.status, input.amount, input.currency, randomUUID()],
  );
  let from: string | null = null;
  for (const step of input.history) {
    await client.query(
      `INSERT INTO payments_status_history (payment_id, from_status, to_status, actor_role, occurred_at)
       VALUES ($1, $2, $3, 'system', $4::timestamptz)`,
      [rows[0]!.id, from, step.to, step.at],
    );
    from = step.to;
  }
}

describe.skipIf(!dbReachable)('spec 037 Overview figures (AC-1, integration)', () => {
  let bookings: Array<{ bookingId: string; customerUserId: string }> = [];

  beforeAll(async () => {
    bookings = [await seedRealBooking(), await seedRealBooking(), await seedRealBooking()];
  }, 120_000);

  afterAll(async () => {
    await getPool().end();
  });

  it("real data, not placeholders: activeRequests counts exactly spec 015's ACTIVE_REQUEST_STATUSES", async () => {
    await withSnapshot(async (db, client) => {
      const before = await countActiveRequests(db);
      for (const status of REQUEST_STATUSES) await seedMinimalRequest(client, status);
      const after = await countActiveRequests(db);
      expect(ACTIVE_REQUEST_STATUSES).toEqual(['submitted', 'matching', 'offers_open', 'provider_selected', 'booking_created']);
      expect(after - before).toBe(ACTIVE_REQUEST_STATUSES.length);
    });
  });

  it('activeBookings counts confirmed, provider_en_route, arrived and in_progress bookings — and none completed or cancelled', async () => {
    const { bookingId } = bookings[0]!;
    await withSnapshot(async (db, client) => {
      const move = (status: string) => client.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId]);
      const baseline = await countActiveBookings(db); // my booking is `confirmed`, so already counted
      for (const status of ['provider_en_route', 'arrived', 'in_progress']) {
        await move(status);
        expect(await countActiveBookings(db)).toBe(baseline);
      }
      await move('completed');
      expect(await countActiveBookings(db)).toBe(baseline - 1);
    });
    await withSnapshot(async (db, client) => {
      const baseline = await countActiveBookings(db);
      await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
      expect(await countActiveBookings(db)).toBe(baseline - 1);
    });
  });

  it("revenue counts only today's UTC captures, per currency — refunds not subtracted, each capture once", async () => {
    const [a, b, c] = bookings.map((x) => x.bookingId) as [string, string, string];
    await withSnapshot(async (db, client) => {
      expect(await revenueForUtcDay(db, DAY)).toEqual([]);

      // Captured today, then refunded the same day: still counts its full charge.
      await insertPayment(client, a, {
        status: 'refunded',
        amount: 150_000,
        currency: 'PKR',
        history: [
          { to: 'created', at: DAY_START },
          { to: 'authorized', at: DAY_START },
          { to: 'captured', at: IN_DAY },
          { to: 'refunded', at: '2091-03-15T20:00:00.000Z' },
        ],
      });
      // Two `captured` rows for one payment (never produced by spec 021, forced here): summed ONCE.
      await insertPayment(client, b, {
        status: 'partially_refunded',
        amount: 50_000,
        currency: 'PKR',
        history: [
          { to: 'captured', at: DAY_START },
          { to: 'captured', at: IN_DAY },
        ],
      });
      await insertPayment(client, c, { status: 'captured', amount: 7_000, currency: 'USD', history: [{ to: 'captured', at: IN_DAY }] });

      expect(await revenueForUtcDay(db, DAY)).toEqual([
        { amountMinorUnits: 200_000, currencyCode: 'PKR' },
        { amountMinorUnits: 7_000, currencyCode: 'USD' },
      ]);
    });
  });

  it('never counts created, requires_action, authorized or failed payments, nor captures outside the UTC day', async () => {
    const [a, b, c] = bookings.map((x) => x.bookingId) as [string, string, string];
    await withSnapshot(async (db, client) => {
      await insertPayment(client, a, {
        status: 'authorized',
        amount: 11_111,
        currency: 'PKR',
        history: [
          { to: 'created', at: IN_DAY },
          { to: 'requires_action', at: IN_DAY },
          { to: 'authorized', at: IN_DAY },
        ],
      });
      await insertPayment(client, b, { status: 'captured', amount: 22_222, currency: 'PKR', history: [{ to: 'captured', at: LAST_INSTANT_BEFORE }] });
      await insertPayment(client, c, { status: 'captured', amount: 33_333, currency: 'PKR', history: [{ to: 'captured', at: NEXT_DAY_START }] });
      expect(await revenueForUtcDay(db, DAY)).toEqual([]);
    });
    await withSnapshot(async (db, client) => {
      await insertPayment(client, a, { status: 'failed', amount: 44_444, currency: 'PKR', history: [{ to: 'failed', at: IN_DAY }] });
      expect(await revenueForUtcDay(db, DAY)).toEqual([]);
    });
  });

  it('critical safety alert: one aggregated alert, only open critical reports counted, only for safety readers', async () => {
    const trustSafety = await adminWithRole('trust_safety_admin');
    const operations = await adminWithRole('operations_admin');
    await withSnapshot(async (db, client) => {
      const before = await countOpenCriticalSafetyReports(db);
      await insertSafetyReport(client, { priority: 'critical', status: 'submitted' });
      await insertSafetyReport(client, { priority: 'critical', status: 'escalated' });
      await insertSafetyReport(client, { priority: 'critical', status: 'resolved' }); // not counted
      await insertSafetyReport(client, { priority: 'high', status: 'submitted' }); // not counted
      const count = await countOpenCriticalSafetyReports(db);
      expect(count - before).toBe(2);

      expect(await alertsFor(db, trustSafety.userId)).toEqual([
        {
          rule: 'critical_safety_reports',
          severity: 'critical',
          count,
          message: criticalSafetyReportsMessage(count),
          linkTo: '/admin/operations/safety',
        },
      ]);
      // operations_admin holds no safety_reports/read: omitted, not hinted at.
      expect(await alertsFor(db, operations.userId)).toEqual([]);
    });
  });

  it('getAdminOverview assembles the live figures with the server instant, for any admin role', async () => {
    const support = await adminWithRole('support_admin');
    await withSnapshot(async (db) => {
      const overview = await getAdminOverview(support.userId, { db, now: DAY });
      expect(overview).toEqual({
        activeRequests: await countActiveRequests(db),
        activeBookings: await countActiveBookings(db),
        revenueToday: [],
        alerts: [],
        generatedAt: DAY.toISOString(),
      });
    });
  });
});
