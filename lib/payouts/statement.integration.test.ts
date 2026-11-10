import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import type { ApiRouteError } from '@/lib/api/errors';
import { createEarningsLineForBooking } from './ledger';
import { resolveDateRange, summaryFigures } from './read';
import { buildStatement, STATEMENT_COLUMNS } from './statement';
import {
  isDatabaseReachable,
  payBooking,
  refundBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

function parse(body: string): Array<Record<string, string>> {
  const [header, ...rows] = body.trim().split('\r\n');
  const columns = header!.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((cell, i) => [columns[i]!, cell])));
}

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code}`);
}

/** Spec 024 §3.11 — the synchronous, bounded CSV statement (AC-6). */
describe.skipIf(!dbReachable)('earnings statement (spec 024 §3.11)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    delete process.env.STATEMENT_MAX_ROWS;
  });

  it('the CSV totals equal the dashboard summary for the same range, with one row per line and recovery', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    await refundBooking(settled, 33_333);

    const statement = await buildStatement(settled.providerProfileId, { from: daysAgo(1), to: inAWeek(), currency: null });
    const rows = parse(statement.body);
    expect(Object.keys(rows[0]!)).toEqual([...STATEMENT_COLUMNS]);
    expect(rows.filter((r) => r.row_type === 'earnings_line')).toHaveLength(1);
    expect(rows.filter((r) => r.row_type === 'refund_recovery')).toHaveLength(1);

    const total = rows.find((r) => r.row_type === 'TOTAL')!;
    const range = await resolveDateRange(settled.providerProfileId, daysAgo(1), inAWeek());
    const summary = await summaryFigures(settled.providerProfileId, 'PKR', range);
    expect(Number(total.gross_amount_minor_units)).toBe(summary.grossAmountMinorUnits);
    expect(Number(total.fee_amount_minor_units)).toBe(summary.feeAmountMinorUnits);
    expect(Number(total.refunded_amount_minor_units)).toBe(summary.refundsAmountMinorUnits);
    expect(Number(total.net_amount_minor_units)).toBe(summary.netAmountMinorUnits);
    expect(Number(total.total_upcoming_amount_minor_units)).toBe(summary.upcomingAmountMinorUnits);
    expect(Number(total.total_paid_amount_minor_units)).toBe(summary.paidAmountMinorUnits);
  });

  it('booking-level rows cover the selected period only', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    const past = await buildStatement(settled.providerProfileId, { from: daysAgo(30), to: daysAgo(10), currency: null });
    expect(parse(past.body).filter((r) => r.row_type === 'earnings_line')).toHaveLength(0);
    const current = await buildStatement(settled.providerProfileId, { from: today(), to: inAWeek(), currency: null });
    expect(parse(current.body).filter((r) => r.row_type === 'earnings_line')).toHaveLength(1);
  });

  it('rejects an inverted, missing or over-long range, and refuses to truncate an over-large result', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    await expectError(() => buildStatement(settled.providerProfileId, { from: null, to: today(), currency: null }), 'STATEMENT_RANGE_INVALID');
    await expectError(() => buildStatement(settled.providerProfileId, { from: today(), to: daysAgo(2), currency: null }), 'STATEMENT_RANGE_INVALID');
    await expectError(() => buildStatement(settled.providerProfileId, { from: daysAgo(400), to: today(), currency: null }), 'STATEMENT_RANGE_INVALID');
    await expectError(() => buildStatement(settled.providerProfileId, { from: '2026-02-30', to: today(), currency: null }), 'STATEMENT_RANGE_INVALID');

    // Two rows (the line and a refund recovery) against a limit of one.
    const paid = await seedSettledBooking();
    await payBooking(paid);
    await refundBooking(paid, 10_000);
    process.env.STATEMENT_MAX_ROWS = '1';
    const err = await expectError(() => buildStatement(paid.providerProfileId, { from: daysAgo(1), to: inAWeek(), currency: null }), 'STATEMENT_RANGE_TOO_LARGE');
    expect(err.details).toMatchObject({ maxRows: 1 });
  });

  it('no payout-method detail beyond the mask, no token, rail reference, refund id or customer identity appears in any cell', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const refundId = await refundBooking(settled, 10_000);
    const { body } = await buildStatement(settled.providerProfileId, { from: daysAgo(1), to: inAWeek(), currency: null });
    expect(body).not.toContain('sandbox_payout_');
    expect(body).not.toContain(refundId);
    expect(body).not.toContain(settled.scenario.customer.userId);
    expect(body).not.toMatch(/\*\*\*\*\d{4}/);
  });
});
