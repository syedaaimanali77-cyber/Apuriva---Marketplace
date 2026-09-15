import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { queryRows } from '@/lib/offers/db';
import { getSandboxPaymentProvider } from '@/lib/payments/provider';
import { readRefundablePosition } from './amounts';
import { requestPolicyRefund } from './execute';
import { registerRefundEligibilityGate } from './eligibility';
import {
  bookingStatusOf,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  paymentStatusOf,
  resetRefundIntegration,
  seedCapturedBooking,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

function codesOf(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as { code?: string }).code ?? 'UNKNOWN');
}

/**
 * Spec 022 §3 "Idempotency and concurrency" (AC-8).
 *
 * The guarantee under test is structural: admission is evaluated under `SELECT ... FOR UPDATE` on
 * the `payments` row in the same transaction that writes the reservation, so two racing requests
 * are SERIALIZED by the database rather than by an application read-then-write that both could win.
 */
describe.skipIf(!dbReachable)('refund concurrency (spec 022 AC-8)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    vi.restoreAllMocks();
  });

  /**
   * AC-8 — TWO CONCURRENT DIFFERENT REQUESTS that together exceed the remaining amount. Exactly one
   * is admitted; the other is refused. Without the row lock, both could read a position permitting
   * their own amount and together over-refund.
   */
  it('two concurrent requests exceeding the remaining amount admit exactly one', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    // Each asks for 60% of the captured amount: either alone fits, both together do not.
    const each = Math.floor(capturedAmountMinorUnits * 0.6);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: each,
      currencyCode: 'PKR',
      reason: 'Concurrent policy refund',
    }));

    const results = await Promise.allSettled([
      requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(codesOf(results)).toEqual(expect.arrayContaining([expect.stringMatching(/REFUND_EXCEEDS_CAPTURED_AMOUNT|REFUND_ALREADY_PROCESSING/)]));

    // THE INVARIANT: never more refunded than captured.
    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits + position.inFlightRefundedMinorUnits).toBeLessThanOrEqual(
      position.capturedAmountMinorUnits,
    );
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });

  /** AC-8 — the same key twice concurrently produces ONE refund and ONE provider call. */
  it('concurrent identical keys produce one refund and one provider call', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
      reason: 'Same-key retry',
    }));

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    const key = freshKey();

    const results = await Promise.allSettled([
      requestPolicyRefund(scenario.customer.userId, bookingId, key),
      requestPolicyRefund(scenario.customer.userId, bookingId, key),
    ]);

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const rows = await queryRows<{ count: string }>(
      getDb(),
      sql`SELECT COUNT(*)::text AS count FROM refunds WHERE booking_id = ${bookingId}`,
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(refundSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  /** AC-8 — three racing requests for the full amount still refund the money exactly once. */
  it('three concurrent full-amount requests refund once', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: capturedAmountMinorUnits,
      currencyCode: 'PKR',
      reason: 'Full refund',
    }));

    await Promise.allSettled([
      requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
    ]);

    const refunds = await storedRefunds(bookingId);
    expect(refunds.filter((r) => r.status === 'completed')).toHaveLength(1);

    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits).toBe(capturedAmountMinorUnits);
    expect(position.remainingRefundableMinorUnits).toBe(0);

    // And the booking was marked refunded exactly once.
    expect(await paymentStatusOf(bookingId)).toBe('refunded');
    expect(await bookingStatusOf(bookingId)).toBe('refunded');
    const history = await queryRows<{ count: string }>(
      getDb(),
      sql`SELECT COUNT(*)::text AS count FROM bookings_status_history
           WHERE booking_id = ${bookingId} AND to_status = 'refunded'`,
    );
    expect(Number(history[0]!.count)).toBe(1);
  });

  /**
   * §4 C-1 — the database index is the backstop, independent of the application's own replay logic.
   * A duplicate key cannot be inserted even by raw SQL.
   */
  it('enforces one refund per idempotency key at the database', async () => {
    const { scenario, bookingId, paymentId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: 10_000,
      currencyCode: 'PKR',
      reason: 'x',
    }));

    const key = freshKey();
    await requestPolicyRefund(scenario.customer.userId, bookingId, key);

    await expect(
      getDb().execute(sql`
        INSERT INTO refunds (payment_id, booking_id, status, total_amount_minor_units, total_currency_code,
                             source, idempotency_key, idempotency_fingerprint)
        VALUES (${paymentId}, ${bookingId}, 'requested', 1000, 'PKR', 'policy', ${key}, 'x')
      `),
    ).rejects.toThrow();

    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });
});
