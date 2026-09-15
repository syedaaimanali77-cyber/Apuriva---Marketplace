import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import type { ApiRouteError } from '@/lib/api/errors';
import { requestPolicyRefund } from './execute';
import {
  SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX,
  allowRefund,
  bookingStatusOf,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  paymentStatusOf,
  refundAmountWithSuffix,
  refundHistory,
  registerRefundEligibilityGate,
  resetRefundIntegration,
  seedCapturedBooking,
  seedStranger,
  storedRefundLines,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe.skipIf(!dbReachable)('refund execution (spec 022 AC-1/AC-2/AC-6)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /**
   * AC-1 — an eligible decision produces a completed refund with no manual step, and the amount is
   * the one spec 023 decided, never one the caller chose.
   */
  it('an eligible decision produces a completed refund with no manual step', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000, 'Cancelled within the free window');

    const { refund, created } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(created).toBe(true);
    expect(refund.status).toBe('completed');
    expect(refund.totalAmountMinorUnits).toBe(50_000);
    expect(refund.totalCurrencyCode).toBe('PKR');
    expect(refund.source).toBe('policy');
    expect(refund.isOverride).toBe(false);
    expect(refund.completedAt).not.toBeNull();
    // AC-4 — the durable reconciliation fact spec 024 consumes.
    expect(refund.reconciliationState).toBe('pending');
  });

  /** AC-2 — immutable lines that sum exactly to the total, carrying the decided reason verbatim. */
  it('a partial refund records immutable lines summing to the total', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000, 'Replacement part not fitted');

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const lines = await storedRefundLines(refund.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line_amount_minor_units).toBe(50_000);
    expect(lines[0]!.line_currency_code).toBe('PKR');
    expect(lines[0]!.reason).toBe('Replacement part not fitted');
    expect(lines.reduce((sum, line) => sum + line.line_amount_minor_units, 0)).toBe(refund.totalAmountMinorUnits);
  });

  /**
   * §3 — a PARTIAL refund moves the payment to `partially_refunded` and leaves the booking alone.
   * `bookings.status = 'refunded'` means FULLY refunded; a partially refunded booking is not a
   * cancelled one.
   */
  it('a partial refund does not mark the booking refunded', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(Math.floor(capturedAmountMinorUnits / 4));

    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(await paymentStatusOf(bookingId)).toBe('partially_refunded');
    expect(await bookingStatusOf(bookingId)).not.toBe('refunded');
  });

  /** §3 — a FULL refund moves both, through spec 020's own transition primitive. */
  it('a full refund marks the payment and the booking refunded', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(capturedAmountMinorUnits);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(refund.status).toBe('completed');
    expect(await paymentStatusOf(bookingId)).toBe('refunded');
    expect(await bookingStatusOf(bookingId)).toBe('refunded');
  });

  /** Two partials that together reach the captured total settle the booking on the second. */
  it('cumulative partial refunds mark the booking refunded only on the last one', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const half = Math.floor(capturedAmountMinorUnits / 2);
    allowRefund(half);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(await bookingStatusOf(bookingId)).not.toBe('refunded');
    expect(await paymentStatusOf(bookingId)).toBe('partially_refunded');

    allowRefund(capturedAmountMinorUnits - half);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(await paymentStatusOf(bookingId)).toBe('refunded');
    expect(await bookingStatusOf(bookingId)).toBe('refunded');

    const refunds = await storedRefunds(bookingId);
    expect(refunds).toHaveLength(2);
    expect(refunds.every((r) => r.status === 'completed')).toBe(true);
  });

  /** AC-1 — a declining gate refunds nothing and creates no row. */
  it('refuses when the eligibility gate declines', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_NOT_ELIGIBLE',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ reason: 'not_eligible' });
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-1 — a gate that throws is "unavailable", never a default-allow. */
  it('refuses when the eligibility gate throws, rather than defaulting to allow', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => {
      throw new Error('policy service down');
    });

    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_NOT_ELIGIBLE',
    );
    expect(error.details).toMatchObject({ reason: 'eligibility_unavailable' });
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** AC-1 — a half-specified decision is a defect in the supplier, never a reason to guess. */
  it('refuses an eligible decision that omits its amount', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({ eligible: true, currencyCode: 'PKR', reason: 'x' }));

    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_ELIGIBILITY_INVALID',
    );
    expect(error.details).toMatchObject({ field: 'amountMinorUnits' });
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** A contradictory currency is refused rather than coerced (I-6). */
  it('refuses an eligible decision in another currency', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: 10_000,
      currencyCode: 'USD',
      reason: 'x',
    }));

    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_CURRENCY_MISMATCH',
    );
    expect(error.details).toMatchObject({ expectedCurrencyCode: 'PKR', receivedCurrencyCode: 'USD' });
  });

  /**
   * AC-6 — a DEFINITIVE provider failure marks the refund `failed`, records the code, and releases
   * its reservation so the money becomes refundable again.
   */
  it('a definitive provider failure marks the refund failed and releases its reservation', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(refundAmountWithSuffix(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX));

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(refund.status).toBe('failed');
    expect(refund.completedAt).toBeNull();

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.failure_code).toBe('refund_declined');

    // Neither the payment nor the booking moved: no money came back.
    expect(await paymentStatusOf(bookingId)).toBe('captured');
    expect(await bookingStatusOf(bookingId)).not.toBe('refunded');
  });

  /** AC-6 — a failed refund is retryable, as a NEW row with a fresh key, never a resurrection. */
  it('a failed refund is retryable as a new row with a fresh key', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    allowRefund(refundAmountWithSuffix(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX));
    const first = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(first.refund.status).toBe('failed');

    // The retry succeeds and is a DIFFERENT refund record.
    allowRefund(50_000);
    const second = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(second.refund.status).toBe('completed');
    expect(second.refund.id).not.toBe(first.refund.id);

    const refunds = await storedRefunds(bookingId);
    expect(refunds).toHaveLength(2);
    expect(refunds.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(refunds.filter((r) => r.status === 'completed')).toHaveLength(1);
  });

  /** §4 C-9 — every transition is attributable, and the history is the proof. */
  it('records an attributable history for every transition', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const history = await refundHistory(refund.id);
    expect(history.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, 'requested'],
      ['requested', 'processing'],
      ['processing', 'completed'],
    ]);
    for (const row of history) {
      expect(row.actor_role).toBe('customer');
      expect(row.actor_user_id).toBe(scenario.customer.userId);
    }
  });

  /** A stranger cannot probe a booking id: `404`, never `403`, and no refund row is created. */
  it('hides a booking from a non-participant behind 404', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const stranger = await seedStranger();
    void scenario;

    await expectError(() => requestPolicyRefund(stranger.customer.userId, bookingId, freshKey()), 'BOOKING_NOT_FOUND');
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** §3 — nothing is refundable before the payment was actually captured. */
  it('refuses a refund when the payment was never captured', async () => {
    // A declined PAYMENT leaves the payment `created`, so there is nothing to refund.
    const { scenario, bookingId } = await seedCapturedBooking({ priceAmountMinorUnits: 321_102 }).catch(async () => {
      // `seedCapturedBooking` throws when the payment is declined; build the booking directly.
      const support = await import('./refunds-test-support');
      const s = await support.seedBookingScenario({ priceAmountMinorUnits: 321_102 });
      const { createBooking } = await import('@/lib/bookings/create');
      const { booking } = await createBooking(s.customer.userId, support.freshKey(), support.createBookingBody(s.offerId));
      return { scenario: s, bookingId: booking.id, paymentId: '', capturedAmountMinorUnits: 0 };
    });

    allowRefund(10_000);
    await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'PAYMENT_NOT_CAPTURED',
    );
  });
});
