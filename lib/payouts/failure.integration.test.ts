import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import {
  getSandboxPayoutProvider,
  SANDBOX_PAYOUT_REJECTED_SUFFIX,
  SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX,
  SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX,
  SANDBOX_PAYOUT_UNKNOWN_SUFFIX,
  SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX,
} from '@/lib/payments/provider';
import { closeBatch } from './ledger';
import { registerPayoutNotificationSink, type PayoutNotificationEvent } from './ports';
import { summaryFigures } from './read';
import { retryFailedPayoutsAutomatically, runPayoutReconcileSweep, transferPayout } from './transfer';
import {
  accrueBooking,
  addDefaultMethod,
  ageFailure,
  ageProcessing,
  historyFor,
  isDatabaseReachable,
  payoutsFor,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
  type SettledBooking,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

const price = (suffix: number) => 32 * 10_000 + suffix;

/** A closed, eligible payout for a booking priced so the sandbox rail produces `suffix`'s outcome. */
async function eligiblePayoutWithSuffix(suffix: number): Promise<{ settled: SettledBooking; payoutId: string }> {
  const settled = await seedSettledBooking({ priceAmountMinorUnits: price(suffix) });
  await addDefaultMethod(settled);
  const payoutId = await accrueBooking(settled);
  expect(await closeBatch(payoutId)).toBe('closed');
  providerOf.set(payoutId, settled.providerProfileId);
  return { settled, payoutId };
}

const providerOf = new Map<string, string>();

/** Every sweep call in this suite is scoped to its own providers, so parallel suites never interfere. */
function scopeOf(...payoutIds: string[]) {
  return { providerProfileIds: payoutIds.map((id) => providerOf.get(id)!) };
}

async function payoutRow(payoutId: string) {
  const [row] = await (await import('@/lib/offers/db')).queryRows<{ status: string; attempt_count: number; failure_code: string | null; payout_reference: string | null; escalated_at: Date | null; payout_method_id: string | null }>(
    getDb(),
    sql`SELECT status, attempt_count, failure_code, payout_reference, escalated_at, payout_method_id FROM payouts WHERE id = ${payoutId}`,
  );
  return row!;
}

/** Spec 024 §3.8 — failed payouts, rail ambiguity and recovery (AC-5, AC-7). Fee 0 so amount = price. */
describe.skipIf(!dbReachable)('payout failure and ambiguity (spec 024 §3.8)', { timeout: SUITE_TIMEOUT_MS }, () => {
  const events: PayoutNotificationEvent[] = [];

  beforeEach(() => {
    usePayoutIntegration({ feeBps: 0 });
    registerBookingBusyIntervals();
    events.length = 0;
    registerPayoutNotificationSink(async (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('a definitive failure sets failed, stores the code, keeps items attached and counts the amount as upcoming', async () => {
    const { settled, payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_REJECTED_SUFFIX);
    expect(await transferPayout(payoutId)).toBe('failed');

    const row = await payoutRow(payoutId);
    expect(row.status).toBe('failed');
    expect(row.failure_code).toBe('transfer_rejected');

    const figures = await summaryFigures(settled.providerProfileId, 'PKR', { fromInstant: null, toInstant: null });
    expect(figures.paidAmountMinorUnits).toBe(0);
    expect(figures.upcomingAmountMinorUnits).toBe(price(SANDBOX_PAYOUT_REJECTED_SUFFIX));
    expect((await historyFor(payoutId)).at(-1)).toMatchObject({ from_status: 'processing', to_status: 'failed', detail: 'transfer_rejected' });
  });

  it('the provider and Finance are both notified of a failure', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_REJECTED_SUFFIX);
    await transferPayout(payoutId);
    const failures = events.filter((e) => e.kind === 'payout_failed' && e.payoutId === payoutId);
    expect(failures.map((e) => (e as { audience: string }).audience).sort()).toEqual(['finance', 'provider']);
  });

  it('an unknown outcome leaves the payout processing, and no second transfer call is issued for that attempt', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_UNKNOWN_SUFFIX);
    expect(await transferPayout(payoutId)).toBe('unknown');
    expect((await payoutRow(payoutId)).status).toBe('processing');

    expect(await transferPayout(payoutId)).toBe('skipped');
    expect(getSandboxPayoutProvider().transfers().filter((t) => t.reference === payoutId)).toHaveLength(1);
  });

  it('the reconcile sweep resolves an unknown outcome through getPayoutStatus', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_UNKNOWN_SUFFIX);
    await transferPayout(payoutId);
    await runPayoutReconcileSweep(scopeOf(payoutId));
    expect((await payoutRow(payoutId)).status).toBe('paid');
    expect(getSandboxPayoutProvider().transfers().filter((t) => t.reference === payoutId)).toHaveLength(1);
  });

  it('a null reference is resolved by idempotency-key lookup only after the attempt grace period', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX);
    await transferPayout(payoutId);
    await runPayoutReconcileSweep(scopeOf(payoutId));
    expect((await payoutRow(payoutId)).status).toBe('processing'); // still inside grace

    await ageProcessing(payoutId, 20);
    await runPayoutReconcileSweep(scopeOf(payoutId));
    expect((await payoutRow(payoutId)).status).toBe('paid');
  });

  it('a crash after claim (never reached the rail) is resolved as transfer_not_received, then retried automatically', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(0);
    // Simulate phase 1 committing and the process dying before phase 2.
    await getDb().transaction(async (tx) => {
      const { applyPayoutTransition } = await import('./state-machine');
      await applyPayoutTransition(tx, { payoutId, from: 'eligible', to: 'processing', actorRole: 'system', actorUserId: null, set: sql`, attempt_count = 1` });
    });
    await ageProcessing(payoutId, 20);
    await runPayoutReconcileSweep(scopeOf(payoutId));
    const failed = await payoutRow(payoutId);
    expect(failed.status).toBe('failed');
    expect(failed.failure_code).toBe('transfer_not_received');

    await ageFailure(payoutId, 31);
    expect(await retryFailedPayoutsAutomatically(scopeOf(payoutId))).toBeGreaterThanOrEqual(1);
    expect((await payoutRow(payoutId)).status).toBe('eligible');
    expect(await transferPayout(payoutId)).toBe('paid');
    expect((await payoutRow(payoutId)).attempt_count).toBe(2);
  });

  it('an unresolved payout is escalated and never marked paid or failed without a rail result', async () => {
    const { payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_UNKNOWN_SUFFIX);
    await transferPayout(payoutId);
    getSandboxPayoutProvider().markUnresolvable((await payoutRow(payoutId)).payout_reference!);
    await ageProcessing(payoutId, 61);

    await runPayoutReconcileSweep(scopeOf(payoutId));
    const row = await payoutRow(payoutId);
    expect(row.status).toBe('processing');
    expect(row.escalated_at).not.toBeNull();
    expect(events.some((e) => e.kind === 'payout_escalated' && e.payoutId === payoutId)).toBe(true);

    await runPayoutReconcileSweep(scopeOf(payoutId));
    expect((await payoutRow(payoutId)).status).toBe('processing');
  });

  it('automatic retries fire only for the closed codes, respect the backoff, and stop at the attempt cap', async () => {
    const rejected = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_REJECTED_SUFFIX);
    await transferPayout(rejected.payoutId);
    await ageFailure(rejected.payoutId, 120);

    const temporary = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX);
    await transferPayout(temporary.payoutId);

    await retryFailedPayoutsAutomatically(scopeOf(rejected.payoutId, temporary.payoutId));
    expect((await payoutRow(rejected.payoutId)).status).toBe('failed'); // transfer_rejected: never automatic
    expect((await payoutRow(temporary.payoutId)).status).toBe('failed'); // inside backoff

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ageFailure(temporary.payoutId, 31);
      await retryFailedPayoutsAutomatically(scopeOf(temporary.payoutId));
      if ((await payoutRow(temporary.payoutId)).status === 'eligible') await transferPayout(temporary.payoutId);
    }
    const capped = await payoutRow(temporary.payoutId);
    expect(capped.status).toBe('failed');
    expect(capped.attempt_count).toBe(3);
    await ageFailure(temporary.payoutId, 31);
    await retryFailedPayoutsAutomatically(scopeOf(temporary.payoutId));
    expect((await payoutRow(temporary.payoutId)).status).toBe('failed');
  });

  it('a destination failure retries automatically only once the provider sets a different usable default', async () => {
    const { settled, payoutId } = await eligiblePayoutWithSuffix(SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX);
    await transferPayout(payoutId);
    await retryFailedPayoutsAutomatically(scopeOf(payoutId));
    expect((await payoutRow(payoutId)).status).toBe('failed');

    const newMethod = await addDefaultMethod(settled, '5678');
    const { setDefaultPayoutMethod } = await import('./payout-methods');
    await setDefaultPayoutMethod({ userId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId, methodId: newMethod, body: { isDefault: true }, correlationId: 'c' });

    await retryFailedPayoutsAutomatically(scopeOf(payoutId));
    const reopened = await payoutRow(payoutId);
    expect(reopened.status).toBe('eligible');
    expect(reopened.payout_method_id).toBe(newMethod);
    const payouts = await payoutsFor(settled.providerProfileId);
    expect(payouts.find((p) => p.id === payoutId)).toBeDefined();
  });
});
