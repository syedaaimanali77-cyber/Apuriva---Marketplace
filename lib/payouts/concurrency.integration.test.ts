import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { queryRows } from '@/lib/offers/db';
import { getSandboxPayoutProvider } from '@/lib/payments/provider';
import { resetRefundReconciliationSink } from '@/lib/refunds/reconciliation';
import { accrueLine, advanceLineEligibility, closeBatch, createEarningsLineForBooking, reconcileRefund } from './ledger';
import { createPayoutMethod, setDefaultPayoutMethod } from './payout-methods';
import { transferPayout } from './transfer';
import {
  accrueBooking,
  addDefaultMethod,
  isDatabaseReachable,
  itemsFor,
  lineFor,
  payBooking,
  payoutsFor,
  reconciliationStateOf,
  refundBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';
import { sandboxSetupToken } from '@/lib/payments/provider';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 §3.15 — concurrency and exactly-once (AC-8, AC-11). */
describe.skipIf(!dbReachable)('payout concurrency (spec 024 §3.15)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('two concurrent line creations produce exactly one line', async () => {
    const settled = await seedSettledBooking();
    const outcomes = await Promise.all([
      createEarningsLineForBooking(settled.bookingId, 1000),
      createEarningsLineForBooking(settled.bookingId, 1000),
      createEarningsLineForBooking(settled.bookingId, 1000),
    ]);
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    const rows = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM provider_earnings_lines WHERE booking_id = ${settled.bookingId}`);
    expect(rows).toHaveLength(1);
  });

  it('two concurrent accruals of the same line attach it once, and one open batch exists', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    const line = await lineFor(settled.bookingId);
    await advanceLineEligibility(line!.id, settled.bookingId);

    await Promise.allSettled([accrueLine(line!.id, settled.bookingId), accrueLine(line!.id, settled.bookingId)]);
    const payouts = await payoutsFor(settled.providerProfileId);
    expect(payouts.filter((p) => p.status === 'pending')).toHaveLength(1);
    expect(await itemsFor(payouts[0]!.id)).toHaveLength(1);
  });

  it('two concurrent transfer workers issue exactly one transfer', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    await closeBatch(payoutId);

    const outcomes = await Promise.all([transferPayout(payoutId), transferPayout(payoutId), transferPayout(payoutId)]);
    expect(outcomes.filter((o) => o === 'paid')).toHaveLength(1);
    expect(getSandboxPayoutProvider().transfers().filter((t) => t.reference === payoutId)).toHaveLength(1);
  });

  it('an earnings line can never have two live earnings items', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    const line = await lineFor(settled.bookingId);
    await expectDatabaseRejection(
      () => getDb().execute(sql`
        INSERT INTO payout_items (payout_id, kind, earnings_line_id, item_amount_minor_units, item_currency_code)
        VALUES (${payoutId}, 'earnings_line', ${line!.id}, 1, 'PKR')`),
      /payout_items_earnings_line_uq/,
    );
  });

  it('a refund can never have two recovery items', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const refundId = await refundBooking(settled, 10_000);
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    const line = await lineFor(settled.bookingId);
    await expectDatabaseRejection(
      () => getDb().execute(sql`
        INSERT INTO payout_items (payout_id, kind, earnings_line_id, source_refund_id, item_amount_minor_units, item_currency_code)
        VALUES (${open.id}, 'refund_recovery', ${line!.id}, ${refundId}, -1, 'PKR')`),
      /payout_items_source_refund_uq/,
    );
  });

  it('concurrent reconciliation of the same refund (sink and pull) has one effect', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    resetRefundReconciliationSink();
    const refundId = await refundBooking(settled, 15_000);

    const outcomes = await Promise.all([reconcileRefund(refundId), reconcileRefund(refundId), reconcileRefund(refundId)]);
    expect(outcomes.filter((o) => o === 'recovery_created')).toHaveLength(1);
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    expect(await itemsFor(open.id)).toHaveLength(1);
  });

  it('a refund reconciliation racing a batch close completes without deadlock, applied exactly once', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const batchId = await accrueBooking(settled);
    resetRefundReconciliationSink();
    const refundId = await refundBooking(settled, 12_000);

    const [reconciled, closed] = await Promise.all([reconcileRefund(refundId), closeBatch(batchId)]);
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');

    const line = await lineFor(settled.bookingId);
    const allItems = (await Promise.all((await payoutsFor(settled.providerProfileId)).map((p) => itemsFor(p.id)))).flat();
    const earnings = allItems.filter((i) => i.kind === 'earnings_line');
    const recoveries = allItems.filter((i) => i.kind === 'refund_recovery');
    // Either detached before the close (no earnings item, no recovery) or recovered after it — never both, never neither.
    if (reconciled === 'detached') {
      expect(earnings).toHaveLength(0);
      expect(recoveries).toHaveLength(0);
    } else {
      expect(['closed', 'not_positive', 'skipped']).toContain(closed);
      const net = earnings.reduce((s, i) => s + i.item_amount_minor_units, 0) + recoveries.reduce((s, i) => s + i.item_amount_minor_units, 0);
      expect(net).toBe(line!.net_amount_minor_units);
    }
  });

  it('two concurrent set-default requests leave exactly one default', async () => {
    const settled = await seedSettledBooking();
    const first = await addDefaultMethod(settled, '1111');
    const { method: second } = await createPayoutMethod({
      userId: settled.scenario.provider.userId,
      providerProfileId: settled.providerProfileId,
      idempotencyKey: 'second',
      body: { setupToken: sandboxSetupToken('bank', '2222', 'PKR') },
      correlationId: 'c',
    });
    const input = (methodId: string) => ({ userId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId, methodId, body: { isDefault: true }, correlationId: 'c' });
    await Promise.allSettled([setDefaultPayoutMethod(input(first)), setDefaultPayoutMethod(input(second.id)), setDefaultPayoutMethod(input(first))]);

    const defaults = await queryRows<{ id: string }>(
      getDb(),
      sql`SELECT id FROM payout_methods WHERE provider_profile_id = ${settled.providerProfileId} AND is_default AND removed_at IS NULL`,
    );
    expect(defaults).toHaveLength(1);
  });
});
