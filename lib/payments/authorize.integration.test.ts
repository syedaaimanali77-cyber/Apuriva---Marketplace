import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { authorizePayment, capturePayment } from './authorize';
import {
  SANDBOX_DECLINE_AMOUNT_SUFFIX,
  SANDBOX_REFERENCE_PREFIX,
  SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX,
} from './provider';
import {
  amountWithSandboxSuffix,
  bookingStatus,
  createBookingBody,
  freshKey,
  paymentAttempts,
  paymentAuthorizations,
  paymentHistory,
  resetPaymentIntegration,
  seedBookingScenario,
  seedStranger,
  storedPayment,
  usePaymentIntegration,
  type BookingScenario,
} from './payments-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

/** File-scoped: an afterAll inside a describe would close the pool before the next describe runs. */
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

/** A booking created through spec 020's real path, left `pending` by spec 021's confirmation gate. */
async function pendingBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  return booking.id;
}

describe.skipIf(!dbReachable)('payment authorization (spec 021 AC-1/AC-2/AC-6/AC-7)', { timeout: SUITE_TIMEOUT_MS }, () => {
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
   * AC-1 — the booking is confirmed ONLY after the adapter confirmed a capture, and the row carries
   * the adapter's own reference. The `sandbox_` prefix proves the reference came from the adapter
   * rather than being generated anywhere in application code.
   */
  it('authorizes through the adapter and records its reference', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    expect(await bookingStatus(bookingId)).toBe('pending');

    const payment = await authorizePayment(scenario.customer.userId, bookingId, freshKey());

    expect(payment.status).toBe('captured');
    expect(await bookingStatus(bookingId)).toBe('confirmed');

    const stored = await storedPayment(bookingId);
    expect(stored!.provider_name).toBe('sandbox');
    expect(stored!.provider_reference?.startsWith(SANDBOX_REFERENCE_PREFIX)).toBe(true);

    const authorizations = await paymentAuthorizations(bookingId);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]!.captured_at).not.toBeNull();
    expect(authorizations[0]!.provider_reference).toBe(stored!.provider_reference);
  });

  /** AC-1 — the charge is the booking's agreed price, copied from the accepted offer, never re-derived. */
  it('charges exactly the booking price in the booking currency', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 415_000 });
    const bookingId = await pendingBooking(scenario);

    const payment = await authorizePayment(scenario.customer.userId, bookingId, freshKey());
    expect(payment.chargeAmountMinorUnits).toBe(415_000);
    expect(payment.chargeCurrencyCode).toBe('PKR');
  });

  /**
   * AC-2 — accepting an offer attempts no payment. `seedBookingScenario` accepts the offer through
   * spec 018's real `acceptOffer`, so if acceptance charged anything a payment row would exist here.
   */
  it('attempts no payment at offer acceptance', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    expect(await storedPayment(bookingId)).toBeUndefined();
    expect(await paymentAttempts(bookingId)).toEqual([]);
  });

  /**
   * AC-6 — the whole point: a decline leaves the booking unconfirmed, records evidence, and says
   * "no charge was confirmed" in the API message itself rather than only in the UI.
   */
  it('failure leaves the booking pending and records an attempt', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX),
    });
    const bookingId = await pendingBooking(scenario);

    const error = await expectError(
      () => authorizePayment(scenario.customer.userId, bookingId, freshKey()),
      'PAYMENT_FAILED',
    );
    expect(error.status).toBe(422);
    expect(error.message).toBe("Payment wasn't completed. No charge was confirmed.");
    expect(error.details).toMatchObject({ failureCode: 'card_declined' });

    expect(await bookingStatus(bookingId)).toBe('pending');

    const attempts = await paymentAttempts(bookingId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('failed');
    expect(attempts[0]!.failure_code).toBe('card_declined');

    // The payment stays retryable — `failed` is terminal and would strand the booking (see the
    // module header); only AC-9's sweep closes it out.
    expect((await storedPayment(bookingId))!.status).toBe('created');
    expect(await paymentAuthorizations(bookingId)).toEqual([]);
  });

  /** AC-6 — a declined booking really is retryable, with a fresh key, and can then succeed. */
  it('stays retryable after a decline', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX),
    });
    const bookingId = await pendingBooking(scenario);

    await expectError(() => authorizePayment(scenario.customer.userId, bookingId, freshKey()), 'PAYMENT_FAILED');
    await expectError(() => authorizePayment(scenario.customer.userId, bookingId, freshKey()), 'PAYMENT_FAILED');

    expect(await paymentAttempts(bookingId)).toHaveLength(2);
    expect(await bookingStatus(bookingId)).toBe('pending');
  });

  /** A distinct provider outcome — not a failure, and definitely not a success. */
  it('reports requires_action distinctly and confirms nothing', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX),
    });
    const bookingId = await pendingBooking(scenario);

    const error = await expectError(
      () => authorizePayment(scenario.customer.userId, bookingId, freshKey()),
      'PAYMENT_REQUIRES_ACTION',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ providerActionKind: 'three_d_secure' });

    expect((await storedPayment(bookingId))!.status).toBe('requires_action');
    expect(await bookingStatus(bookingId)).toBe('pending');

    const attempts = await paymentAttempts(bookingId);
    expect(attempts.at(-1)!.status).toBe('requires_action');
  });

  /** §4 I-7 — attribution is provable: the customer is named on every transition they caused. */
  it('attributes every transition to the paying customer', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await authorizePayment(scenario.customer.userId, bookingId, freshKey());

    // The sandbox separates authorization from capture, so the payment walks the full
    // `created -> authorized -> captured` path — two provider round trips, each recorded.
    const history = await paymentHistory(bookingId);
    expect(history.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, 'created'],
      ['created', 'authorized'],
      ['authorized', 'captured'],
    ]);
    for (const row of history) {
      expect(row.actor_role).toBe('customer');
      expect(row.actor_user_id).toBe(scenario.customer.userId);
    }
  });

  /** A stranger cannot probe a booking id: `404`, never `403`, and never a payment row. */
  it('hides a booking from a non-participant behind 404', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    const stranger = await seedStranger();

    await expectError(() => authorizePayment(stranger.customer.userId, bookingId, freshKey()), 'BOOKING_NOT_FOUND');
    expect(await storedPayment(bookingId)).toBeUndefined();
  });

  /** A booking already confirmed is not awaiting payment; a second, different key is not a retry. */
  it('refuses authorization on a booking that is no longer pending', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await authorizePayment(scenario.customer.userId, bookingId, freshKey());

    const error = await expectError(
      () => authorizePayment(scenario.customer.userId, bookingId, freshKey()),
      'BOOKING_NOT_AWAITING_PAYMENT',
    );
    expect(error.status).toBe(422);
  });
});

describe.skipIf(!dbReachable)('payment capture (spec 021 AC-7)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** The sandbox captures at authorization, so a same-key capture is the documented no-op replay. */
  it('replays an already-captured payment under the same key', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    const key = freshKey();

    const authorized = await authorizePayment(scenario.customer.userId, bookingId, key);
    const captured = await capturePayment(scenario.customer.userId, bookingId, key);

    expect(captured.status).toBe('captured');
    expect(captured.version).toBe(authorized.version);
    // No second authorization row, and no extra attempt: nothing was charged twice.
    expect(await paymentAuthorizations(bookingId)).toHaveLength(1);
  });

  /** A capture under a DIFFERENT key on an already-captured payment is a genuine duplicate. */
  it('refuses a duplicate capture under a different key with PAYMENT_ALREADY_CAPTURED', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);
    await authorizePayment(scenario.customer.userId, bookingId, freshKey());

    const error = await expectError(
      () => capturePayment(scenario.customer.userId, bookingId, freshKey()),
      'PAYMENT_ALREADY_CAPTURED',
    );
    expect(error.status).toBe(409);
    expect(await paymentAuthorizations(bookingId)).toHaveLength(1);
  });

  /** Capturing what was never authorized is not a failure to report — it is a state error. */
  it('refuses to capture a payment the provider never authorized', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await pendingBooking(scenario);

    const error = await expectError(
      () => capturePayment(scenario.customer.userId, bookingId, freshKey()),
      'PAYMENT_NOT_AUTHORIZED',
    );
    expect(error.status).toBe(422);
  });
});
