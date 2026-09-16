import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { queryRows } from '@/lib/offers/db';
import { closeBatch, createEarningsLineForBooking, readCapturedGross } from './ledger';
import { summaryFigures } from './read';
import { runPayoutSweep } from './sweep';
import {
  accrueBooking,
  addDefaultMethod,
  isDatabaseReachable,
  lineFor,
  payBooking,
  payoutsFor,
  refundBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 150_000;
const ALL_TIME = { fromInstant: null, toInstant: null };

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 — master spec §113's financial list, restricted to what this spec owns (mandatory). */
describe.skipIf(!dbReachable)('payout financial invariants (spec 024, master spec §113)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration({ feeBps: 1250 });
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('payout pending: an accruing batch reports pending and upcoming, never paid', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1250);
    let f = await summaryFigures(settled.providerProfileId, 'PKR', ALL_TIME);
    expect(f.pendingAmountMinorUnits).toBe((await lineFor(settled.bookingId))!.net_amount_minor_units);
    expect(f.paidAmountMinorUnits).toBe(0);

    await addDefaultMethod(settled);
    await accrueBooking(settled);
    f = await summaryFigures(settled.providerProfileId, 'PKR', ALL_TIME);
    expect(f.pendingAmountMinorUnits).toBe(0);
    expect(f.upcomingAmountMinorUnits).toBe((await lineFor(settled.bookingId))!.net_amount_minor_units);
    expect(f.paidAmountMinorUnits).toBe(0);
  });

  it('both summary identities hold over a mixed ledger of paid, refunded and recovering lines', async () => {
    const a = await seedSettledBooking();
    await payBooking(a);
    await refundBooking(a, 77_777);

    const b = await seedSettledBooking();
    await createEarningsLineForBooking(b.bookingId, 1250);
    const f = await summaryFigures(a.providerProfileId, 'PKR', ALL_TIME);
    expect(f.netAmountMinorUnits).toBe(f.grossAmountMinorUnits - f.feeAmountMinorUnits + f.adjustmentsAmountMinorUnits - f.refundsAmountMinorUnits);
    expect(f.pendingAmountMinorUnits + f.upcomingAmountMinorUnits + f.paidAmountMinorUnits).toBe(f.netAmountMinorUnits);
    expect(f.upcomingAmountMinorUnits).toBeLessThan(0);
  });

  it('gross equals spec 022’s captured sum and never includes charged price adjustments', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1250);
    const [position] = await queryRows<{ captured: number }>(
      getDb(),
      sql`SELECT COALESCE(SUM(captured_amount_minor_units),0)::int AS captured FROM payment_authorizations WHERE payment_id = ${settled.paymentId} AND captured_at IS NOT NULL`,
    );
    expect((await lineFor(settled.bookingId))!.gross_amount_minor_units).toBe(position!.captured);
    expect((await readCapturedGross(getDb(), settled.paymentId)).grossAmountMinorUnits).toBe(position!.captured);
  });

  it('a payout failure leaves paid at zero and returns the amount to upcoming', async () => {
    usePayoutIntegration({ feeBps: 0 });
    const settled = await seedSettledBooking({ priceAmountMinorUnits: 32 * 10_000 + 3102 });
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    await closeBatch(payoutId);
    const { transferPayout } = await import('./transfer');
    expect(await transferPayout(payoutId)).toBe('failed');
    const f = await summaryFigures(settled.providerProfileId, 'PKR', ALL_TIME);
    expect(f.paidAmountMinorUnits).toBe(0);
    expect(f.upcomingAmountMinorUnits).toBe(32 * 10_000 + 3102);
  });

  it('duplicate-payout prevention: a sweep run twice pays a line once', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    await runPayoutSweep({ providerProfileIds: [settled.providerProfileId] });
    await runPayoutSweep({ providerProfileIds: [settled.providerProfileId] });
    const paid = (await payoutsFor(settled.providerProfileId)).filter((p) => p.status === 'paid');
    expect(paid).toHaveLength(1);
    const f = await summaryFigures(settled.providerProfileId, 'PKR', ALL_TIME);
    expect(f.paidAmountMinorUnits).toBe((await lineFor(settled.bookingId))!.net_amount_minor_units);
  });

  it('fee arithmetic at the rounding boundary matches the stored line', async () => {
    usePayoutIntegration({ feeBps: 5000 });
    const settled = await seedSettledBooking({ priceAmountMinorUnits: 320_001 });
    await createEarningsLineForBooking(settled.bookingId, 5000);
    const line = await lineFor(settled.bookingId);
    expect(line!.fee_amount_minor_units).toBe(160_001); // 160000.5 rounds half-up
    expect(line!.net_amount_minor_units).toBe(160_000);
  });

  it('zero and negative amounts are unrepresentable on a line, and currency is uniform', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1250);
    const line = await lineFor(settled.bookingId);
    await expectDatabaseRejection(() => getDb().execute(sql`UPDATE provider_earnings_lines SET net_amount_minor_units = -1, refunded_amount_minor_units = refunded_amount_minor_units WHERE id = ${line!.id}`), /provider_earnings_lines_(amounts|net_identity)_ck/);
    await expectDatabaseRejection(() => getDb().execute(sql`UPDATE provider_earnings_lines SET net_currency_code = 'USD' WHERE id = ${line!.id}`), /currency_uniform/);
  });

  it('every stored money column this spec adds is an integer', () => {
    const tables = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];
    for (const table of tables) {
      const config = getTableConfig(table);
      if (!['payouts', 'provider_earnings_lines', 'earnings_adjustments', 'payout_items'].includes(config.name)) continue;
      for (const column of config.columns.filter((c) => /_minor_units$|_bps$/.test(c.name))) {
        expect(column.columnType, `${config.name}.${column.name}`).toBe('PgInteger');
      }
    }
  });
});
