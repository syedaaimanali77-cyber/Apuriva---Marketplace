import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { seedMinimalRequest } from '@/lib/db/test-support';
import { EXPLORATION_SHARE } from '@/lib/matching/fairness';
import { insertUser, isDatabaseReachable, seedRealBooking, withSnapshot } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import {
  funnelReport,
  matchingFairnessReport,
  providerPerformanceReport,
  retentionReport,
  revenueReport,
  serviceTrendsReport,
  supplyDemandReport,
} from './reports';

/**
 * Spec 040 §3.6 (AC-2, AC-4) — every formula against seeded data. Each assertion runs in spec 037's
 * `withSnapshot` (REPEATABLE READ, always rolled back) over a PRIVATE far-future window no other test
 * writes into, so every figure is exact despite parallel files sharing the `*_test` database.
 *
 * W = [2093-06-01, 2093-06-11), P (the previous equal window) = [2093-05-22, 2093-06-01).
 */
const dbReachable = await isDatabaseReachable();

const W = { from: new Date('2093-06-01T00:00:00.000Z'), to: new Date('2093-06-11T00:00:00.000Z') };
const IN_W = '2093-06-05T10:00:00.000Z';
const IN_P = '2093-05-25T10:00:00.000Z';
const BEFORE_P = '2093-05-01T10:00:00.000Z';
const AFTER_W = '2093-06-11T00:00:00.000Z'; // `to` is exclusive

interface RealBooking {
  bookingId: string;
  requestId: string;
  offerId: string;
  providerProfileId: string;
  customerProfileId: string;
  serviceId: string;
}

async function describeBooking(bookingId: string): Promise<RealBooking> {
  const { rows } = await getPool().query<RealBooking>(
    `SELECT id AS "bookingId", request_id AS "requestId", offer_id AS "offerId", provider_profile_id AS "providerProfileId",
            customer_profile_id AS "customerProfileId", service_id AS "serviceId"
       FROM bookings WHERE id = $1`,
    [bookingId],
  );
  return rows[0]!;
}

async function bareProvider(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>('INSERT INTO provider_profiles (user_id) VALUES ($1) RETURNING id', [
    await insertUser(client),
  ]);
  return rows[0]!.id;
}

async function requestFacts(client: PoolClient, requestId: string): Promise<{ customerProfileId: string; serviceId: string }> {
  const { rows } = await client.query<{ customerProfileId: string; serviceId: string }>(
    'SELECT customer_profile_id AS "customerProfileId", service_id AS "serviceId" FROM requests WHERE id = $1',
    [requestId],
  );
  return rows[0]!;
}

async function insertMatch(
  client: PoolClient,
  input: { requestId: string; providerProfileId: string; notifiedAt: string | null; boosted?: boolean; respondedAfterMinutes?: number },
): Promise<void> {
  const responded = input.respondedAfterMinutes !== undefined;
  await client.query(
    `INSERT INTO request_provider_matches
       (request_id, provider_profile_id, eligible, rank, score_micros, exploration_boosted, notified_at, provider_response, responded_at)
     VALUES ($1, $2, true, 1, 500000, $3, $4::timestamptz, $5,
             CASE WHEN $6::int IS NULL THEN NULL ELSE $4::timestamptz + make_interval(mins => $6::int) END)`,
    [input.requestId, input.providerProfileId, input.boosted ?? false, input.notifiedAt, responded ? 'declined' : 'none', input.respondedAfterMinutes ?? null],
  );
}

async function insertEarningsLine(
  client: PoolClient,
  booking: RealBooking,
  line: { currency: string; gross: number; feeBps: number; refunded: number; feeReversal: number; createdAt: string },
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO payments (booking_id, status, charge_amount_minor_units, charge_currency_code, provider_name, idempotency_key, idempotency_fingerprint)
     VALUES ($1, 'captured', $2, $3, 'sandbox', $4, 'fp') RETURNING id`,
    [booking.bookingId, line.gross, line.currency, randomUUID()],
  );
  const fee = Math.floor((line.gross * line.feeBps) / 10_000);
  const net = line.gross - line.refunded - fee + line.feeReversal;
  await client.query(
    `INSERT INTO provider_earnings_lines
       (created_at, booking_id, provider_profile_id, payment_id, service_id, gross_amount_minor_units, gross_currency_code,
        platform_fee_bps, fee_amount_minor_units, fee_currency_code, refunded_amount_minor_units, refunded_currency_code,
        fee_reversal_amount_minor_units, fee_reversal_currency_code, net_amount_minor_units, net_currency_code)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9, $7, $10, $7, $11, $7, $12, $7)`,
    [line.createdAt, booking.bookingId, booking.providerProfileId, rows[0]!.id, booking.serviceId, line.gross, line.currency, line.feeBps, fee, line.refunded, line.feeReversal, net],
  );
}

describe.skipIf(!dbReachable)('spec 040 §3.6 report formulas (AC-2, AC-4)', { timeout: 240_000 }, () => {
  let b1: RealBooking;
  let b2: RealBooking;

  beforeAll(async () => {
    b1 = await describeBooking((await seedRealBooking()).bookingId);
    b2 = await describeBooking((await seedRealBooking()).bookingId);
  }, 180_000);

  /**
   * The shared fixture, inside the caller's snapshot:
   *   requests  — r1, x2, x3 in W; r2, x1 in P (x2 re-pointed to x1's customer: one retained customer;
   *               x3 re-pointed to x1's service: a service with both a current and a previous request)
   *   offers    — o1 sent in W
   *   bookings  — b1 and b2 created in W; b1 completed in W, b2 cancelled
   *   searches  — three `search_performed` events in W, one just outside, one other type in W
   */
  async function seedWindow(client: PoolClient) {
    const [x1, x2, x3] = [
      await seedMinimalRequest(client, 'submitted'),
      await seedMinimalRequest(client, 'submitted'),
      await seedMinimalRequest(client, 'submitted'),
    ];
    const x1Facts = await requestFacts(client, x1);
    const x2Facts = await requestFacts(client, x2);
    await client.query('UPDATE requests SET customer_profile_id = $1 WHERE id = $2', [x1Facts.customerProfileId, x2]);
    await client.query('UPDATE requests SET service_id = $1 WHERE id = $2', [x1Facts.serviceId, x3]);
    const setCreated = (id: string, at: string) => client.query('UPDATE requests SET created_at = $1::timestamptz WHERE id = $2', [at, id]);
    await setCreated(b1.requestId, IN_W);
    await setCreated(x2, IN_W);
    await setCreated(x3, IN_W);
    await setCreated(b2.requestId, IN_P);
    await setCreated(x1, IN_P);

    await client.query("SET LOCAL apuriva.test_offer_window_shift = 'on'");
    // Shifted as a pair: `offers_two_minute_window_ck` ties `expires_at` to `sent_at`.
    const shiftOffer = (id: string, at: string) =>
      client.query('UPDATE offers SET sent_at = $1::timestamptz, expires_at = expires_at + ($1::timestamptz - sent_at) WHERE id = $2', [at, id]);
    await shiftOffer(b1.offerId, IN_W);
    await shiftOffer(b2.offerId, BEFORE_P);

    await client.query('UPDATE bookings SET created_at = $1::timestamptz WHERE id = ANY($2::uuid[])', [IN_W, [b1.bookingId, b2.bookingId]]);
    await client.query(
      `INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_role, occurred_at)
       VALUES ($1, 'in_progress', 'completed', 'system', $2::timestamptz)`,
      [b1.bookingId, IN_W],
    );
    await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [b2.bookingId]);

    const search = (type: string, at: string) =>
      client.query(`INSERT INTO analytics_events (event_type, occurred_at, properties) VALUES ($1, $2::timestamptz, $3)`, [
        type,
        at,
        JSON.stringify(type === 'search_performed' ? { hasQuery: true, hasLocation: false, resultCount: 1 } : { conversationId: randomUUID() }),
      ]);
    for (let i = 0; i < 3; i += 1) await search('search_performed', IN_W);
    await search('search_performed', AFTER_W);
    await search('ai_conversation_started', IN_W);

    return { x1, x2, x3, x1Service: x1Facts.serviceId, x2Service: x2Facts.serviceId };
  }

  it('funnel: period counts per stage; conversion may exceed 1; null for discover', async () => {
    await withSnapshot(async (db, client) => {
      await seedWindow(client);
      const report = await funnelReport(db, W);
      expect(report.periodStart).toBe(W.from.toISOString());
      expect(report.periodEnd).toBe(W.to.toISOString());
      expect(report.stages).toEqual([
        { stage: 'discover', count: 3, conversionFromPrevious: null },
        { stage: 'request', count: 3, conversionFromPrevious: 1 },
        { stage: 'offer', count: 1, conversionFromPrevious: 0.3333 },
        { stage: 'booking', count: 2, conversionFromPrevious: 2 },
        { stage: 'complete', count: 1, conversionFromPrevious: 0.5 },
      ]);
    });
  });

  it('funnel: conversion is null when the previous stage is 0, and an empty window is all zeros', async () => {
    await withSnapshot(async (db) => {
      const empty = await funnelReport(db, { from: new Date('2094-01-01T00:00:00Z'), to: new Date('2094-01-02T00:00:00Z') });
      expect(empty.stages.map((s) => [s.count, s.conversionFromPrevious])).toEqual([
        [0, null],
        [0, null],
        [0, null],
        [0, null],
        [0, null],
      ]);
    });
  });

  it('revenue: per currency, sorted, never summed across currencies, net fee after reversals', async () => {
    await withSnapshot(async (db, client) => {
      await insertEarningsLine(client, b1, { currency: 'PKR', gross: 100_000, feeBps: 1000, refunded: 20_000, feeReversal: 2_000, createdAt: IN_W });
      await insertEarningsLine(client, b2, { currency: 'USD', gross: 5_000, feeBps: 1000, refunded: 0, feeReversal: 0, createdAt: IN_W });
      const report = await revenueReport(db, W);
      expect(report.currencies).toEqual([
        {
          currencyCode: 'PKR',
          lineCount: 1,
          grossMinorUnits: 100_000,
          refundsMinorUnits: 20_000,
          feeMinorUnits: 10_000,
          feeReversalMinorUnits: 2_000,
          netFeeMinorUnits: 8_000,
          providerNetMinorUnits: 72_000,
        },
        {
          currencyCode: 'USD',
          lineCount: 1,
          grossMinorUnits: 5_000,
          refundsMinorUnits: 0,
          feeMinorUnits: 500,
          feeReversalMinorUnits: 0,
          netFeeMinorUnits: 500,
          providerNetMinorUnits: 4_500,
        },
      ]);
      // A line created outside W is not counted.
      expect((await revenueReport(db, { from: new Date('2093-07-01T00:00:00Z'), to: new Date('2093-07-02T00:00:00Z') })).currencies).toEqual([]);
    });
  });

  it('supply/demand: requests in W vs current active providers per service, demand-first', async () => {
    await withSnapshot(async (db, client) => {
      const { x1Service, x2Service } = await seedWindow(client);
      const { rows } = await client.query<{ service_id: string; supply: number }>(
        `SELECT ps.service_id, count(DISTINCT ps.provider_profile_id)::int AS supply
           FROM provider_services ps JOIN provider_profiles pp ON pp.id = ps.provider_profile_id AND pp.lifecycle_status = 'active'
          WHERE ps.service_id = ANY($1::uuid[]) GROUP BY ps.service_id`,
        [[b1.serviceId, x1Service, x2Service]],
      );
      const activeSupply = new Map(rows.map((r) => [r.service_id, r.supply]));
      expect(activeSupply.get(b1.serviceId)).toBeGreaterThan(0);

      const report = await supplyDemandReport(db, W);
      const withDemand = report.services.filter((s) => s.demand > 0);
      // Only the three services requested in W have demand, and they lead the list.
      expect(report.services.slice(0, 3).every((s) => s.demand > 0)).toBe(true);
      expect(withDemand.map((s) => s.serviceId).sort()).toEqual([b1.serviceId, x1Service, x2Service].sort());
      for (const row of withDemand) {
        const supply = activeSupply.get(row.serviceId) ?? 0;
        expect(row).toMatchObject({ demand: 1, supply, demandPerProvider: supply === 0 ? null : Math.round((1 / supply) * 100) / 100 });
      }
      expect(report.services.every((s) => s.demand > 0 || s.supply > 0)).toBe(true);
      expect(report.services.length).toBeLessThanOrEqual(50);
    });
  });

  it('provider performance: exposure share, response time, completion rate, rating; paged; no score or name', async () => {
    await withSnapshot(async (db, client) => {
      const { x1, x2, x3 } = await seedWindow(client);
      const p1 = b1.providerProfileId;
      const p2 = b2.providerProfileId;
      await insertMatch(client, { requestId: x1, providerProfileId: p1, notifiedAt: IN_W, respondedAfterMinutes: 30 });
      await insertMatch(client, { requestId: x2, providerProfileId: p1, notifiedAt: IN_W, respondedAfterMinutes: 60 });
      await insertMatch(client, { requestId: x3, providerProfileId: p1, notifiedAt: IN_W });
      await insertMatch(client, { requestId: x1, providerProfileId: p2, notifiedAt: IN_W, boosted: true });
      await insertMatch(client, { requestId: x2, providerProfileId: p2, notifiedAt: IN_W, boosted: true });
      await insertMatch(client, { requestId: x3, providerProfileId: p2, notifiedAt: IN_P }); // outside W
      const others: string[] = [];
      for (let i = 0; i < 9; i += 1) {
        const q = await bareProvider(client);
        others.push(q);
        await insertMatch(client, { requestId: x1, providerProfileId: q, notifiedAt: IN_W, boosted: i === 0 });
      }
      const unnotified = await bareProvider(client);
      await insertMatch(client, { requestId: x2, providerProfileId: unnotified, notifiedAt: null });

      const all = await providerPerformanceReport(db, W, { limit: 100, offset: 0 });
      expect(all.total).toBe(11);
      expect(all.rows.map((r) => r.providerProfileId)).toEqual([p1, p2, ...others.sort()]);
      expect(all.rows[0]).toEqual({
        providerProfileId: p1,
        notifications: 3,
        exposureShare: 0.2143,
        responseTimeMinutes: 45,
        completionRate: 1,
        averageRating: null,
        ratingCount: null,
      });
      expect(all.rows[1]).toMatchObject({ providerProfileId: p2, notifications: 2, exposureShare: 0.1429, responseTimeMinutes: null, completionRate: 0 });
      expect(all.rows[2]).toMatchObject({ notifications: 1, exposureShare: 0.0714, completionRate: null });
      for (const row of all.rows) {
        expect(Object.keys(row).sort()).toEqual(
          ['averageRating', 'completionRate', 'exposureShare', 'notifications', 'providerProfileId', 'ratingCount', 'responseTimeMinutes'].sort(),
        );
      }

      const page = await providerPerformanceReport(db, W, { limit: 2, offset: 10 });
      expect(page.total).toBe(11);
      expect(page.rows).toHaveLength(1);
    });
  });

  it('AC-4 matching fairness: computed from persisted request_provider_matches, not a manual figure', async () => {
    await withSnapshot(async (db, client) => {
      const empty = await matchingFairnessReport(db, W);
      expect(empty).toMatchObject({
        notifications: 0,
        boostedNotifications: 0,
        boostedShare: null,
        distinctProvidersNotified: 0,
        topDecileExposureShare: null,
        configuredExplorationCap: EXPLORATION_SHARE,
      });

      const { x1, x2, x3 } = await seedWindow(client);
      const p1 = b1.providerProfileId;
      const p2 = b2.providerProfileId;
      for (const r of [x1, x2, x3]) await insertMatch(client, { requestId: r, providerProfileId: p1, notifiedAt: IN_W });
      for (const r of [x1, x2]) await insertMatch(client, { requestId: r, providerProfileId: p2, notifiedAt: IN_W, boosted: true });
      for (let i = 0; i < 9; i += 1) {
        await insertMatch(client, { requestId: x1, providerProfileId: await bareProvider(client), notifiedAt: IN_W, boosted: i === 0 });
      }
      await insertMatch(client, { requestId: x3, providerProfileId: p2, notifiedAt: IN_P, boosted: true }); // outside W

      const report = await matchingFairnessReport(db, W);
      // 14 notifications (3 + 2 + 9) over 11 providers; 3 boosted; the top ⌈10% of 11⌉ = 2 providers hold 5.
      expect(report).toEqual({
        notifications: 14,
        boostedNotifications: 3,
        boostedShare: 0.2143,
        configuredExplorationCap: EXPLORATION_SHARE,
        distinctProvidersNotified: 11,
        topDecileExposureShare: 0.3571,
        periodStart: W.from.toISOString(),
        periodEnd: W.to.toISOString(),
      });

      // It moves with the data: one more boosted notification changes the computed figure.
      await insertMatch(client, { requestId: x2, providerProfileId: await bareProvider(client), notifiedAt: IN_W, boosted: true });
      expect((await matchingFairnessReport(db, W)).boostedNotifications).toBe(4);
    });
  });

  it('retention: customers active in P and again in W', async () => {
    await withSnapshot(async (db, client) => {
      await seedWindow(client);
      const report = await retentionReport(db, W);
      expect(report).toEqual({
        previousPeriodStart: '2093-05-22T00:00:00.000Z',
        previousActiveCustomers: 2,
        currentActiveCustomers: 3,
        retainedCustomers: 1,
        retentionRate: 0.5,
        periodStart: W.from.toISOString(),
        periodEnd: W.to.toISOString(),
      });
      const none = await retentionReport(db, { from: new Date('2094-01-01T00:00:00Z'), to: new Date('2094-01-02T00:00:00Z') });
      expect(none.retentionRate).toBeNull();
    });
  });

  it('service trends: current vs previous requests per service; only services requested in W', async () => {
    await withSnapshot(async (db, client) => {
      const { x1Service, x2Service } = await seedWindow(client);
      const report = await serviceTrendsReport(db, W);
      expect(report.previousPeriodStart).toBe('2093-05-22T00:00:00.000Z');
      const byId = new Map(report.services.map((s) => [s.serviceId, s]));
      expect([...byId.keys()].sort()).toEqual([b1.serviceId, x1Service, x2Service].sort());
      expect(byId.get(x1Service)).toMatchObject({ currentRequests: 1, previousRequests: 1, changeRate: 0 });
      expect(byId.get(b1.serviceId)).toMatchObject({ currentRequests: 1, previousRequests: 0, changeRate: null });
      expect(byId.has(b2.serviceId)).toBe(false); // requested only in P

      // A second current request for x1's service: (2 − 1) ÷ 1 = 1.
      const extra = await seedMinimalRequest(client, 'submitted');
      await client.query('UPDATE requests SET service_id = $1, created_at = $2::timestamptz WHERE id = $3', [x1Service, IN_W, extra]);
      const again = await serviceTrendsReport(db, W);
      expect(again.services[0]).toMatchObject({ serviceId: x1Service, currentRequests: 2, previousRequests: 1, changeRate: 1 });
    });
  });
});
