import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { authorizePayment } from './authorize';
import { approvePriceAdjustment, chargeRemainder, proposePriceAdjustment, rejectPriceAdjustment } from './price-adjustment';
import { SANDBOX_DECLINE_AMOUNT_SUFFIX } from './provider';
import { storedBooking } from '@/lib/bookings/bookings-test-support';
import {
  amountWithSandboxSuffix,
  createBookingBody,
  freshKey,
  paymentAttempts,
  resetPaymentIntegration,
  seedBookingScenario,
  storedAdjustments,
  usePaymentIntegration,
  type BookingScenario,
} from './payments-test-support';

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

/** A paid, confirmed booking — the state a mid-service price change actually happens in. */
async function paidBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  await authorizePayment(scenario.customer.userId, booking.id, freshKey());
  return booking.id;
}

describe.skipIf(!dbReachable)('price adjustments (spec 021 AC-3/AC-4)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** AC-4 — a proposal is a proposal. No adapter is reached and nothing is charged. */
  it('proposal charges nothing', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);
    const attemptsBefore = (await paymentAttempts(bookingId)).length;

    const { adjustment, created } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Replacement part required',
    });

    expect(created).toBe(true);
    expect(adjustment.status).toBe('pending_approval');
    expect(adjustment.approvedAt).toBeNull();
    expect(await paymentAttempts(bookingId)).toHaveLength(attemptsBefore);

    const stored = await storedAdjustments(bookingId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.payment_id).toBeNull();
    expect(stored[0]!.approved_by_user_id).toBeNull();
  });

  /**
   * AC-4 — the amount charged is necessarily the amount shown, because approval and charge are
   * bound to the same immutable row. Master spec §46/§132.15: never silently charge a changed amount.
   */
  it('approval charges exactly the amount shown', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Replacement part required',
    });

    const approved = await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());

    expect(approved.status).toBe('charged');
    expect(approved.additionalAmountMinorUnits).toBe(45_000);
    expect(approved.additionalCurrencyCode).toBe('PKR');
    expect(approved.approvedAt).not.toBeNull();

    const stored = await storedAdjustments(bookingId);
    expect(stored[0]!.payment_id).not.toBeNull();
    expect(stored[0]!.approved_by_user_id).toBe(scenario.customer.userId);
  });

  /**
   * AC-4 / AC-3 — the gate itself. `chargeRemainder` is the deposit path's charging entry point;
   * handed an unapproved adjustment it refuses, so the remainder can never be taken silently.
   */
  it('charge without approval is 422 ADJUSTMENT_APPROVAL_REQUIRED', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);
    const attemptsBefore = (await paymentAttempts(bookingId)).length;

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const error = await expectError(
      () => chargeRemainder(scenario.customer.userId, bookingId, adjustment.id, freshKey()),
      'ADJUSTMENT_APPROVAL_REQUIRED',
    );
    expect(error.status).toBe(422);

    // Nothing reached the adapter, and the row is untouched.
    expect(await paymentAttempts(bookingId)).toHaveLength(attemptsBefore);
    expect((await storedAdjustments(bookingId))[0]!.status).toBe('pending_approval');
  });

  /** AC-3 — and once approved, the same entry point does charge, so the gate is the only obstacle. */
  it('chargeRemainder succeeds only once an approval is on record', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 60_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Balance due',
    });
    await expectError(
      () => chargeRemainder(scenario.customer.userId, bookingId, adjustment.id, freshKey()),
      'ADJUSTMENT_APPROVAL_REQUIRED',
    );

    const approved = await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());
    expect(approved.status).toBe('charged');
  });

  /** AC-4's negative branch — declining is terminal and charges nothing. */
  it('reject charges nothing', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);
    const attemptsBefore = (await paymentAttempts(bookingId)).length;

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const rejected = await rejectPriceAdjustment(scenario.customer.userId, adjustment.id);
    expect(rejected.status).toBe('rejected');
    expect(await paymentAttempts(bookingId)).toHaveLength(attemptsBefore);

    // And a rejected adjustment can never later be approved.
    const error = await expectError(
      () => approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey()),
      'ADJUSTMENT_ALREADY_RESOLVED',
    );
    expect(error.status).toBe(409);
  });

  /** Only the CUSTOMER may approve. A provider approving their own price change is the whole risk. */
  it('refuses a provider approving their own proposal', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    await expectError(
      () => approvePriceAdjustment(scenario.provider.userId, adjustment.id, freshKey()),
      'PAYMENT_NOT_FOUND',
    );
    expect((await storedAdjustments(bookingId))[0]!.status).toBe('pending_approval');
  });

  /** Only the PROVIDER may propose — a customer cannot invent a charge against themselves either. */
  it('refuses a customer proposing a price change', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    await expectError(
      () =>
        proposePriceAdjustment(scenario.customer.userId, bookingId, freshKey(), {
          additionalAmountMinorUnits: 45_000,
          additionalCurrencyCode: 'PKR',
          reason: 'nope',
        }),
      'BOOKING_NOT_FOUND',
    );
    expect(await storedAdjustments(bookingId)).toEqual([]);
  });

  /** §3 rule 5 — an adjustment must be in the booking's own currency. */
  it('refuses an adjustment in another currency', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const error = await expectError(
      () =>
        proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
          additionalAmountMinorUnits: 45_000,
          additionalCurrencyCode: 'USD',
          reason: 'Extra time',
        }),
      'ADJUSTMENT_CURRENCY_MISMATCH',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ expectedCurrencyCode: 'PKR', receivedCurrencyCode: 'USD' });
  });

  it('rejects a non-positive or malformed proposal', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    await expectError(
      () =>
        proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
          additionalAmountMinorUnits: 0,
          additionalCurrencyCode: 'PKR',
          reason: 'Extra time',
        }),
      'VALIDATION_ERROR',
    );
    await expectError(
      () =>
        proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
          additionalAmountMinorUnits: 4_000,
          additionalCurrencyCode: 'PKR',
          reason: '   ',
        }),
      'VALIDATION_ERROR',
    );
  });

  /**
   * §3 — an adjustment is spec 021's own entity, NOT an edit to the agreed booking price. Spec 020
   * owns those columns and `bookings_terms_immutable_trg` enforces it; this asserts the outcome.
   */
  it('never rewrites the agreed booking price', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 320_000 });
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Replacement part',
    });
    await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());

    const booking = await storedBooking(bookingId);
    expect(booking.price_amount_minor_units).toBe(320_000);
    expect(booking.price_currency_code).toBe('PKR');
  });

  /** A declined adjustment charge records the failure and leaves the row `failed`, never `charged`. */
  it('records a declined adjustment charge as failed, never charged', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX, 4),
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    await expectError(
      () => approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey()),
      'PAYMENT_FAILED',
    );

    const stored = await storedAdjustments(bookingId);
    expect(stored[0]!.status).toBe('failed');
    expect(stored[0]!.payment_id).toBeNull();
  });

  /** AC-7 — a replayed proposal under the same key creates one row, not two. */
  it('replays a proposal under the same idempotency key', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);
    const key = freshKey();
    const body = { additionalAmountMinorUnits: 45_000, additionalCurrencyCode: 'PKR', reason: 'Extra time' };

    const first = await proposePriceAdjustment(scenario.provider.userId, bookingId, key, body);
    const second = await proposePriceAdjustment(scenario.provider.userId, bookingId, key, body);

    expect(second.created).toBe(false);
    expect(second.adjustment.id).toBe(first.adjustment.id);
    expect(await storedAdjustments(bookingId)).toHaveLength(1);
  });

  it('refuses the same key for a different proposal', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);
    const key = freshKey();

    await proposePriceAdjustment(scenario.provider.userId, bookingId, key, {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const error = await expectError(
      () =>
        proposePriceAdjustment(scenario.provider.userId, bookingId, key, {
          additionalAmountMinorUnits: 90_000,
          additionalCurrencyCode: 'PKR',
          reason: 'Extra time',
        }),
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    expect(error.status).toBe(409);
    expect(await storedAdjustments(bookingId)).toHaveLength(1);
  });

  /** Approving twice is idempotent — the second call returns the charged row, charging nothing more. */
  it('approving twice charges once', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBooking(scenario);

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, bookingId, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());
    const attemptsAfterFirst = (await paymentAttempts(bookingId)).length;

    const second = await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());
    expect(second.status).toBe('charged');
    expect(await paymentAttempts(bookingId)).toHaveLength(attemptsAfterFirst);
  });
});
