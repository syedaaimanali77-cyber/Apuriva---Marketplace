import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { queryRows } from '@/lib/offers/db';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { completeBooking } from '@/lib/bookings/complete';
import { driveToInProgress, bookingHistory } from '@/lib/bookings/bookings-test-support';
import { authorizePayment } from './authorize';
import { approvePriceAdjustment, proposePriceAdjustment, rejectPriceAdjustment } from './price-adjustment';
import { runPaymentSweep } from './sweep';
import {
  backdateProtectionWindow,
  bookingStatus,
  createBookingBody,
  freshKey,
  paymentAttempts,
  paymentAuthorizations,
  resetPaymentIntegration,
  seedBookingScenario,
  storedAdjustments,
  storedPayment,
  usePaymentIntegration,
} from './payments-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

/** Settled results, so a rejected promise is an outcome to inspect rather than a test failure. */
async function race<T>(...tasks: Array<Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(tasks);
}

function codesOf(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as { code?: string }).code ?? 'UNKNOWN');
}

describe.skipIf(!dbReachable)('payment concurrency (spec 021 §3, AC-7)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /**
   * AC-7 — the structural guarantee. `payments_booking_id_uq` (I-1) makes two concurrent first-time
   * authorizations produce ONE payment row, not two, whatever the application logic does. This is
   * master spec §132.6's "do not create duplicate bookings on retries", applied to money.
   */
  it('concurrent authorizations produce one payment row', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    const results = await race(
      authorizePayment(scenario.customer.userId, booking.id, freshKey()),
      authorizePayment(scenario.customer.userId, booking.id, freshKey()),
    );

    // At least one must have succeeded; neither may have produced a second payment or capture.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const rows = await queryRows<{ count: string }>(
      getDb(),
      sql`SELECT COUNT(*)::text AS count FROM payments WHERE booking_id = ${booking.id}`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(await paymentAuthorizations(booking.id)).toHaveLength(1);
    expect((await storedPayment(booking.id))!.status).toBe('captured');
    expect(await bookingStatus(booking.id)).toBe('confirmed');
  });

  /** And the booking is confirmed exactly once — never two `pending -> confirmed` history rows. */
  it('confirms the booking exactly once under a concurrent authorization race', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await race(
      authorizePayment(scenario.customer.userId, booking.id, freshKey()),
      authorizePayment(scenario.customer.userId, booking.id, freshKey()),
      authorizePayment(scenario.customer.userId, booking.id, freshKey()),
    );

    const confirmations = (await bookingHistory(booking.id)).filter((row) => row.to_status === 'confirmed');
    expect(confirmations).toHaveLength(1);
  });

  /** AC-7 — the same key twice concurrently replays; the provider is called once, not twice. */
  it('concurrent retries under the same key charge once', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    const key = freshKey();

    await race(
      authorizePayment(scenario.customer.userId, booking.id, key),
      authorizePayment(scenario.customer.userId, booking.id, key),
    );

    expect(await paymentAuthorizations(booking.id)).toHaveLength(1);
    const succeeded = (await paymentAttempts(booking.id)).filter((a) => a.status === 'succeeded');
    // One authorize + one capture round trip. Never two of either.
    expect(succeeded).toHaveLength(2);
  });

  /**
   * §3 "Idempotency and concurrency" — two concurrent approvals of one adjustment resolve to ONE
   * charge. The loser makes no adapter call at all, which is what stops a double charge rather than
   * merely reporting one.
   */
  it('concurrent approvals of one adjustment charge once', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());
    const attemptsBefore = (await paymentAttempts(booking.id)).length;

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, booking.id, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const results = await race(
      approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey()),
      approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey()),
    );

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const stored = await storedAdjustments(booking.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('charged');

    // Exactly ONE additional provider round trip beyond the original payment.
    expect((await paymentAttempts(booking.id)).length).toBe(attemptsBefore + 1);
  });

  /** A concurrent approve and reject resolve the same way: first writer wins, the other is told. */
  it('a concurrent approve and reject resolve to one decision', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, booking.id, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const results = await race(
      approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey()),
      rejectPriceAdjustment(scenario.customer.userId, adjustment.id),
    );

    const stored = await storedAdjustments(booking.id);
    expect(['charged', 'rejected']).toContain(stored[0]!.status);
    // Whichever lost was told the current state rather than silently succeeding.
    const rejectedCodes = codesOf(results);
    if (rejectedCodes.length > 0) expect(rejectedCodes).toEqual(['ADJUSTMENT_ALREADY_RESOLVED']);
  });

  /**
   * §9 "Cron" — two overlapping sweep invocations (the scheduler fires every minute; a slow run can
   * overlap the next) must not release the same protection twice or settle a booking twice.
   */
  it('overlapping sweep runs release a protection once', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());
    await driveToInProgress(scenario, booking.id);
    await completeBooking(scenario.provider.userId, booking.id, 'provider');

    await runPaymentSweep();
    await backdateProtectionWindow(booking.id, 49);

    const results = await race(runPaymentSweep(), runPaymentSweep());
    const released = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runPaymentSweep>>> => r.status === 'fulfilled')
      .reduce((total, r) => total + r.value.protectionReleased, 0);

    expect(released).toBe(1);
    expect((await storedPayment(booking.id))!.protection_state).toBe('released');
    expect(await bookingStatus(booking.id)).toBe('settled');

    const settlements = (await bookingHistory(booking.id)).filter((row) => row.to_status === 'settled');
    expect(settlements).toHaveLength(1);
  });
});
