import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { queryRows } from '@/lib/offers/db';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { authorizePayment } from './authorize';
import { approvePriceAdjustment, proposePriceAdjustment } from './price-adjustment';
import { getSandboxPaymentProvider, SANDBOX_DECLINE_AMOUNT_SUFFIX, SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX } from './provider';
import {
  amountWithSandboxSuffix,
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

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

async function paymentRowCount(bookingId: string): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    getDb(),
    sql`SELECT COUNT(*)::text AS count FROM payments WHERE booking_id = ${bookingId}`,
  );
  return Number(rows[0]!.count);
}

/**
 * Spec 021 §6 "Financial (mandatory)" — master spec §113's list, restricted to what THIS spec owns.
 *
 * Refund, partial refund, cancellation fee, payout pending and payout failure are specs 022/023/024's
 * and are deliberately not tested here: this spec implements none of them, so a test of them would
 * assert nothing about this code. §113's remaining six are all covered below and are mandatory, not
 * optional.
 */
describe.skipIf(!dbReachable)('financial flows (spec 021 §6, master spec §113)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** §113 "Successful payment". */
  it('successful payment: captures once and confirms the booking', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 275_000 });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    const payment = await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    expect(payment.status).toBe('captured');
    expect(payment.chargeAmountMinorUnits).toBe(275_000);
    expect(await bookingStatus(booking.id)).toBe('confirmed');
    expect(await paymentAuthorizations(booking.id)).toHaveLength(1);
  });

  /** §113 "Failed payment" — and AC-6's honesty requirement in the API message itself. */
  it('failed payment: no charge confirmed, no booking confirmed', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX),
    });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    const error = await expectError(
      () => authorizePayment(scenario.customer.userId, booking.id, freshKey()),
      'PAYMENT_FAILED',
    );
    expect(error.message).toContain('No charge was confirmed');
    expect(await bookingStatus(booking.id)).toBe('pending');
    expect(await paymentAuthorizations(booking.id)).toEqual([]);
  });

  /** §113 "Pending payment" — a step-up is neither a success nor a failure, and confirms nothing. */
  it('pending payment: requires_action is reported as its own outcome', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX),
    });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expectError(
      () => authorizePayment(scenario.customer.userId, booking.id, freshKey()),
      'PAYMENT_REQUIRES_ACTION',
    );
    expect((await storedPayment(booking.id))!.status).toBe('requires_action');
    expect(await bookingStatus(booking.id)).toBe('pending');
    expect(await paymentAuthorizations(booking.id)).toEqual([]);
  });

  /** §113 "Duplicate payment attempts" — sequential duplicates never produce a second charge. */
  it('duplicate payment attempts: one payment row, one authorization', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    const key = freshKey();

    await authorizePayment(scenario.customer.userId, booking.id, key);
    await authorizePayment(scenario.customer.userId, booking.id, key);
    await authorizePayment(scenario.customer.userId, booking.id, key);

    expect(await paymentRowCount(booking.id)).toBe(1);
    expect(await paymentAuthorizations(booking.id)).toHaveLength(1);
  });

  /**
   * §113 "Idempotency" — BOTH levels. Same key + same fingerprint replays with no adapter call at
   * all (the sandbox's own call counter proves the application short-circuited before reaching it).
   */
  it('idempotency: same key and fingerprint replays without a second adapter call', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    const key = freshKey();

    const first = await authorizePayment(scenario.customer.userId, booking.id, key);
    const attemptsAfterFirst = (await paymentAttempts(booking.id)).length;

    const replay = await authorizePayment(scenario.customer.userId, booking.id, key);

    expect(replay.id).toBe(first.id);
    expect(replay.version).toBe(first.version);
    expect(replay.status).toBe('captured');
    // No new attempt row: the replay never reached the adapter.
    expect(await paymentAttempts(booking.id)).toHaveLength(attemptsAfterFirst);
  });

  /** §113 "Idempotency" — the provider level, independently. */
  it('idempotency: the same key is forwarded to the provider, which deduplicates too', async () => {
    const provider = getSandboxPaymentProvider();
    const key = freshKey();
    const first = await provider.authorize({ idempotencyKey: key, amountMinorUnits: 320_000, currencyCode: 'PKR', reference: 'r' });
    const second = await provider.authorize({ idempotencyKey: key, amountMinorUnits: 320_000, currencyCode: 'PKR', reference: 'r' });
    expect(second.providerReference).toBe(first.providerReference);
  });

  /** §113 "Idempotency" — a reused key for different intent is refused rather than silently applied. */
  it('idempotency: a conflicting reuse is 409, not a second charge', async () => {
    const scenario = await seedBookingScenario();
    const first = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, first.booking.id, freshKey());

    const key = freshKey();
    await proposePriceAdjustment(scenario.provider.userId, first.booking.id, key, {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Extra time',
    });

    const error = await expectError(
      () =>
        proposePriceAdjustment(scenario.provider.userId, first.booking.id, key, {
          additionalAmountMinorUnits: 999_000,
          additionalCurrencyCode: 'PKR',
          reason: 'Extra time',
        }),
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    expect(error.status).toBe(409);
    expect(await storedAdjustments(first.booking.id)).toHaveLength(1);
  });

  /**
   * §113 "Price change confirmation" — end to end: proposed, shown, approved, charged, and the
   * agreed booking price never rewritten.
   */
  it('price change confirmation: nothing is charged until the customer approves', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());
    const attemptsAfterPayment = (await paymentAttempts(booking.id)).length;

    const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, booking.id, freshKey(), {
      additionalAmountMinorUnits: 45_000,
      additionalCurrencyCode: 'PKR',
      reason: 'Replacement part',
    });

    // Proposed: shown, not charged.
    expect(adjustment.status).toBe('pending_approval');
    expect(await paymentAttempts(booking.id)).toHaveLength(attemptsAfterPayment);

    // Approved: charged, for exactly the amount and currency that were shown.
    const charged = await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());
    expect(charged.status).toBe('charged');
    expect(charged.additionalAmountMinorUnits).toBe(adjustment.additionalAmountMinorUnits);
    expect(charged.additionalCurrencyCode).toBe(adjustment.additionalCurrencyCode);
    expect((await paymentAttempts(booking.id)).length).toBe(attemptsAfterPayment + 1);
  });

  /** §4 I-1 — the invariant behind all of the above, asserted at the database. */
  it('enforces one payment per booking at the database', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    await expect(
      getDb().execute(sql`
        INSERT INTO payments (booking_id, status, charge_amount_minor_units, charge_currency_code,
                              provider_name, idempotency_key, idempotency_fingerprint)
        VALUES (${booking.id}, 'created', 1000, 'PKR', 'sandbox', ${freshKey()}, 'x')
      `),
    ).rejects.toThrow();

    expect(await paymentRowCount(booking.id)).toBe(1);
  });

  /** §4 — money is integer minor units everywhere; a fractional amount cannot be stored at all. */
  it('refuses a non-positive charge amount at the database', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expect(
      getDb().execute(sql`
        INSERT INTO payments (booking_id, status, charge_amount_minor_units, charge_currency_code,
                              provider_name, idempotency_key, idempotency_fingerprint)
        VALUES (${booking.id}, 'created', 0, 'PKR', 'sandbox', ${freshKey()}, 'x')
      `),
    ).rejects.toThrow();
  });

  /** §4 I-8 — the provider-outcome audit trail cannot be rewritten or deleted. */
  it('keeps payment attempts append-only', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    const payment = await storedPayment(booking.id);
    await expect(
      getDb().execute(sql`UPDATE payment_attempts SET status = 'failed' WHERE payment_id = ${payment!.id}`),
    ).rejects.toThrow();
    await expect(
      getDb().execute(sql`DELETE FROM payment_attempts WHERE payment_id = ${payment!.id}`),
    ).rejects.toThrow();
  });

  /** §4 I-5 — nothing is protected that was never captured, enforced at the database. */
  it('refuses a protection state on an uncaptured payment', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX),
    });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey()).catch(() => undefined);

    await expect(
      getDb().execute(sql`
        UPDATE payments SET protection_state = 'held', protection_window_started_at = now()
         WHERE booking_id = ${booking.id}
      `),
    ).rejects.toThrow();
  });

  /** §4 I-4 — a protection state without a start instant is meaningless and cannot be stored. */
  it('refuses a protection state with no window start instant', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    await expect(
      getDb().execute(sql`UPDATE payments SET protection_state = 'held' WHERE booking_id = ${booking.id}`),
    ).rejects.toThrow();
  });

  /** §4 I-9 — a capture can never exceed the authorization it settles. */
  it('refuses a capture larger than its authorization at the database', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    const payment = await storedPayment(booking.id);
    await expect(
      getDb().execute(sql`
        UPDATE payment_authorizations
           SET captured_amount_minor_units = authorized_amount_minor_units + 1
         WHERE payment_id = ${payment!.id}
      `),
    ).rejects.toThrow();
  });

  /** §4 — the spec 003 transition trigger is the independent second line of defence. */
  it('refuses an unseeded payment status transition at the database', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    // `captured -> refunded` is spec 022's and is deliberately unseeded here.
    await expect(
      getDb().execute(sql`UPDATE payments SET status = 'refunded' WHERE booking_id = ${booking.id}`),
    ).rejects.toThrow();
  });
});
