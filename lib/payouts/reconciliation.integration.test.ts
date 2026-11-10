import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetRefundReconciliationSink } from '@/lib/refunds/reconciliation';
import { computeLineFigures } from './fees';
import { closeBatch, createEarningsLineForBooking, reconcileRefund } from './ledger';
import { summaryFigures } from './read';
import { runPayoutSweep } from './sweep';
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
import { advanceLineEligibility } from './ledger';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;
const FEE = 1000;

afterAll(async () => {
  await getPool().end();
});

async function expectIdentities(providerProfileId: string): Promise<void> {
  const f = await summaryFigures(providerProfileId, 'PKR', { fromInstant: null, toInstant: null });
  expect(f.netAmountMinorUnits).toBe(f.grossAmountMinorUnits - f.feeAmountMinorUnits + f.adjustmentsAmountMinorUnits - f.refundsAmountMinorUnits);
  expect(f.pendingAmountMinorUnits + f.upcomingAmountMinorUnits + f.paidAmountMinorUnits).toBe(f.netAmountMinorUnits);
}

/** Spec 024 §3.7 — refund reconciliation, exactly once, in every §3.7 situation (AC-2). */
describe.skipIf(!dbReachable)('refund reconciliation (spec 024 §3.7)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration({ feeBps: FEE });
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('a refund on a booking with no line is marked reconciled only, and Pass A includes it later with no recovery', async () => {
    const settled = await seedSettledBooking();
    resetRefundReconciliationSink(); // prove the pull path, not the push
    const refundId = await refundBooking(settled, 50_000);
    expect(await reconciliationStateOf(refundId)).toBe('pending');

    expect(await createEarningsLineForBooking(settled.bookingId, FEE)).toBe('created');
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');
    const line = await lineFor(settled.bookingId);
    expect(line!.refunded_amount_minor_units).toBe(50_000);
    expect(line!.net_amount_minor_units).toBe(computeLineFigures(settled.capturedAmountMinorUnits, FEE, 50_000).netAmountMinorUnits);
    expect(await payoutsFor(settled.providerProfileId)).toHaveLength(0);
  });

  it('an unattached eligible line is reduced in place and returned to pending', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, FEE);
    const line = await lineFor(settled.bookingId);
    await advanceLineEligibility(line!.id, settled.bookingId);

    resetRefundReconciliationSink();
    const refundId = await refundBooking(settled, 40_000);
    expect(await reconcileRefund(refundId)).toBe('reduced_in_place');

    const after = await lineFor(settled.bookingId);
    expect(after!.state).toBe('pending');
    expect(after!.refunded_amount_minor_units).toBe(40_000);
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');
    await expectIdentities(settled.providerProfileId);
  });

  it('an earnings item in a pending batch is detached, the batch total recomputed, and re-attached later at the new net', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const batchId = await accrueBooking(settled);
    const before = await lineFor(settled.bookingId);

    resetRefundReconciliationSink();
    const refundId = await refundBooking(settled, 30_000);
    expect(await reconcileRefund(refundId)).toBe('detached');
    expect(await itemsFor(batchId)).toHaveLength(0);
    expect((await payoutsFor(settled.providerProfileId))[0]!.payout_amount_minor_units).toBe(0);

    const detached = await lineFor(settled.bookingId);
    expect(detached!.state).toBe('pending');
    expect(detached!.net_amount_minor_units).toBeLessThan(before!.net_amount_minor_units);

    await advanceLineEligibility(detached!.id, settled.bookingId);
    const { accrueLine } = await import('./ledger');
    await accrueLine(detached!.id, settled.bookingId);
    const [item] = await itemsFor(batchId);
    expect(item!.item_amount_minor_units).toBe(detached!.net_amount_minor_units);
    await expectIdentities(settled.providerProfileId);
  });

  it('a refund after the payout is paid produces exactly one recovery item of −Δnet in the next batch', async () => {
    const settled = await seedSettledBooking();
    const paidPayoutId = await payBooking(settled);
    const paidLine = await lineFor(settled.bookingId);

    const refundId = await refundBooking(settled, 60_000); // the registered sink reconciles immediately
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');

    const afterLine = await lineFor(settled.bookingId);
    expect(afterLine!.state).toBe('paid');
    const delta = paidLine!.net_amount_minor_units - afterLine!.net_amount_minor_units;
    expect(delta).toBeGreaterThan(0);

    const payouts = await payoutsFor(settled.providerProfileId);
    const open = payouts.find((p) => p.status === 'pending')!;
    expect(open.id).not.toBe(paidPayoutId);
    const items = await itemsFor(open.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'refund_recovery', source_refund_id: refundId, item_amount_minor_units: -delta });
    expect(open.payout_amount_minor_units).toBe(-delta);

    // A negative batch never closes.
    expect(await closeBatch(open.id)).toBe('not_positive');

    // I-24: net = earnings item + Σ recovery items.
    const [earningsItem] = await itemsFor(paidPayoutId);
    expect(earningsItem!.item_amount_minor_units - delta).toBe(afterLine!.net_amount_minor_units);
    await expectIdentities(settled.providerProfileId);
  });

  it('two partial refunds on a paid line produce two recovery items summing to the total reduction', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const paidNet = (await lineFor(settled.bookingId))!.net_amount_minor_units;

    await refundBooking(settled, 11_111);
    await refundBooking(settled, 22_223);

    const finalNet = (await lineFor(settled.bookingId))!.net_amount_minor_units;
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    const recoveries = (await itemsFor(open.id)).filter((i) => i.kind === 'refund_recovery');
    expect(recoveries).toHaveLength(2);
    expect(recoveries.reduce((sum, i) => sum + i.item_amount_minor_units, 0)).toBe(finalNet - paidNet);
    expect(finalNet).toBe(computeLineFigures(settled.capturedAmountMinorUnits, FEE, 33_334).netAmountMinorUnits);
    await expectIdentities(settled.providerProfileId);
  });

  it('a replayed sink callback and a replayed sweep each write nothing the second time', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const refundId = await refundBooking(settled, 25_000);

    expect(await reconcileRefund(refundId)).toBe('noop');
    await runPayoutSweep({ providerProfileIds: [settled.providerProfileId] });
    expect(await reconcileRefund(refundId)).toBe('noop');

    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    expect((await itemsFor(open.id)).filter((i) => i.kind === 'refund_recovery')).toHaveLength(1);
  });

  it('a throwing sink loses nothing: the pull pass picks the refund up', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const { registerRefundReconciliationSink } = await import('@/lib/refunds/reconciliation');
    registerRefundReconciliationSink(async () => {
      throw new Error('sink outage');
    });
    const refundId = await refundBooking(settled, 25_000);
    expect(await reconciliationStateOf(refundId)).toBe('pending');

    await runPayoutSweep({ providerProfileIds: [settled.providerProfileId] });
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    expect((await itemsFor(open.id)).filter((i) => i.kind === 'refund_recovery')).toHaveLength(1);
  });

  it('a refund reaching a closed-but-unsent payout creates a recovery rather than touching the frozen batch', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const batchId = await accrueBooking(settled);
    expect(await closeBatch(batchId)).toBe('closed');

    const refundId = await refundBooking(settled, 20_000);
    expect(await reconciliationStateOf(refundId)).toBe('reconciled');
    expect(await itemsFor(batchId)).toHaveLength(1);
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    expect((await itemsFor(open.id))[0]!.kind).toBe('refund_recovery');
    await expectIdentities(settled.providerProfileId);
  });
});
