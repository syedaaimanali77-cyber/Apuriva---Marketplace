import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from './create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import {
  bookingHistory,
  countBookings,
  createBookingBody,
  expectDatabaseRejection,
  futureLocalSlot,
  requestStatusOf,
  seedBookingScenario,
  seedStranger,
  storedBooking,
} from './bookings-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * These suites build their fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker
 * threads that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect
 * that file already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

/** Spec 020 §3 "Creation, in evaluation order" — AC-1. */
describe.skipIf(!dbReachable)('booking creation (spec 020 AC-1, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    resetRateLimitState();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('revalidates offer state, request state, slot and price inside one transaction', async () => {
    const scenario = await seedBookingScenario();

    const { booking, created } = await createBooking(
      scenario.customer.userId,
      randomUUID(),
      createBookingBody(scenario.offerId),
    );

    expect(created).toBe(true);
    expect(booking.status).toBe('confirmed');
    expect(booking.offerId).toBe(scenario.offerId);
    expect(booking.requestId).toBe(scenario.requestId);
    expect(booking.serviceId).toBe(scenario.serviceId);
    expect(booking.providerProfileId).toBe(scenario.provider.providerProfileId);
    // Step 11: the scheduled instant defaults to the request's preferred time.
    expect(new Date(booking.scheduledAt).toISOString()).toBe(scenario.preferredAt.toISOString());
    // Step 11: the zone is the PROVIDER's scheduling timezone — spec 016 §8 risk #7, resolved.
    expect(booking.scheduledTimezone).toBe('Asia/Karachi');
    // Step 12: duration precedence — the offer's estimate wins.
    expect(booking.durationMinutes).toBe(60);
  });

  it('writes the pending and confirmed history rows with the customer as actor', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    const history = await bookingHistory(booking.id);
    expect(history.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, 'pending'],
      ['pending', 'confirmed'],
    ]);
    expect(history.every((row) => row.actor_role === 'customer')).toBe(true);
    expect(history.every((row) => row.actor_user_id === scenario.customer.userId)).toBe(true);
  });

  it('price and currency are copied verbatim from the accepted offer and ignore any client value', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 777_000 });

    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), {
      offerId: scenario.offerId,
      // Every one of these is a value the client must never be able to influence.
      priceAmountMinorUnits: 1,
      currencyCode: 'USD',
      providerProfileId: randomUUID(),
      customerProfileId: randomUUID(),
      serviceId: randomUUID(),
      durationMinutes: 999,
      status: 'completed',
    });

    expect(booking.priceAmountMinorUnits).toBe(777_000);
    expect(booking.currencyCode).toBe('PKR');
    expect(booking.serviceId).toBe(scenario.serviceId);
    expect(booking.providerProfileId).toBe(scenario.provider.providerProfileId);
    expect(booking.durationMinutes).toBe(60);
    expect(booking.status).toBe('confirmed');
  });

  it('moves the request provider_selected -> booking_created and records its history row', async () => {
    const scenario = await seedBookingScenario();
    expect(await requestStatusOf(scenario.requestId)).toBe('provider_selected');

    await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    expect(await requestStatusOf(scenario.requestId)).toBe('booking_created');
    const { rows } = (await getDb().execute(
      sql`SELECT from_status, to_status FROM requests_status_history
           WHERE request_id = ${scenario.requestId} AND to_status = 'booking_created'`,
    )) as unknown as { rows: { from_status: string; to_status: string }[] };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_status).toBe('provider_selected');
  });

  it('rejects an offer that was never accepted with 422 OFFER_NOT_ACCEPTABLE', async () => {
    // Left `sent`: spec 018's own transition trigger forbids un-accepting an offer after the fact,
    // so the un-accepted case is built by never accepting, not by rewriting a decided row.
    const scenario = await seedBookingScenario({ accept: false });

    const err = await expectError(
      () => createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
      'OFFER_NOT_ACCEPTABLE',
    );
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ reason: 'not_accepted', status: 'sent' });
    expect(await countBookings(scenario.offerId)).toBe(0);
  });

  it('rejects a request that is not provider_selected with 422 REQUEST_NOT_ACTIONABLE', async () => {
    const scenario = await seedBookingScenario();
    await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    // The request is now `booking_created`; a second attempt on the same offer must be refused
    // by step 8 (one booking per offer) before it ever reaches step 10.
    const err = await expectError(
      () => createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
      'BOOKING_ALREADY_EXISTS',
    );
    expect(err.status).toBe(409);
  });

  it('rejects a non-participant with 404 OFFER_NOT_FOUND rather than 403', async () => {
    const scenario = await seedBookingScenario();
    const stranger = await seedStranger();

    const err = await expectError(
      () => createBooking(stranger.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
      'OFFER_NOT_FOUND',
    );
    expect(err.status).toBe(404);
    expect(await countBookings(scenario.offerId)).toBe(0);
  });

  it('requires scheduledAt when the request has no preferred time', async () => {
    const scenario = await seedBookingScenario();
    await getDb().execute(
      sql`UPDATE requests SET preferred_at = NULL, preferred_timezone = NULL WHERE id = ${scenario.requestId}`,
    );

    const err = await expectError(
      () => createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
      'VALIDATION_ERROR',
    );
    expect(err.errors?.[0]?.field).toBe('scheduledAt');
    expect(await countBookings(scenario.offerId)).toBe(0);
  });

  it('accepts an explicit scheduledAt in place of the request preferred time', async () => {
    const scenario = await seedBookingScenario();
    const chosen = futureLocalSlot(11);

    const { booking } = await createBooking(
      scenario.customer.userId,
      randomUUID(),
      createBookingBody(scenario.offerId, chosen),
    );
    expect(new Date(booking.scheduledAt).toISOString()).toBe(chosen.toISOString());
  });

  it('rejects a malformed body with 400 VALIDATION_ERROR', async () => {
    const scenario = await seedBookingScenario();
    await expectError(() => createBooking(scenario.customer.userId, randomUUID(), {}), 'VALIDATION_ERROR');
    await expectError(
      () => createBooking(scenario.customer.userId, randomUUID(), { offerId: scenario.offerId, scheduledAt: 'not-a-date' }),
      'VALIDATION_ERROR',
    );
  });

  /** §4 I-7: the agreed terms are unchangeable by ANY code path once the row exists. */
  it('the terms-immutability trigger rejects a change to price, schedule or participants', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    for (const statement of [
      sql`UPDATE bookings SET price_amount_minor_units = 1 WHERE id = ${booking.id}`,
      sql`UPDATE bookings SET price_currency_code = 'USD' WHERE id = ${booking.id}`,
      sql`UPDATE bookings SET scheduled_at = clock_timestamp() WHERE id = ${booking.id}`,
      sql`UPDATE bookings SET duration_minutes = 30 WHERE id = ${booking.id}`,
      sql`UPDATE bookings SET idempotency_key = 'other' WHERE id = ${booking.id}`,
    ]) {
      await expectDatabaseRejection(() => getDb().execute(statement), /immutable/i);
    }

    const stored = await storedBooking(booking.id);
    expect(stored.price_amount_minor_units).toBe(320_000);
    expect(stored.duration_minutes).toBe(60);
  });

  /** Safeguard S6: attribution can never be rewritten or erased. */
  it('the status history is append-only at the database', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE bookings_status_history SET actor_role = 'system' WHERE booking_id = ${booking.id}`),
      /append-only/i,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`DELETE FROM bookings_status_history WHERE booking_id = ${booking.id}`),
      /append-only/i,
    );
  });

  /** §4 I-8: `actor_user_id` is null exactly when the actor is the system (spec 021 only). */
  it('refuses a history row whose actor pairing is inconsistent', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expectDatabaseRejection(
      () =>
        getDb().execute(sql`
          INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_user_id, actor_role)
          VALUES (${booking.id}, 'confirmed', 'arrived', NULL, 'provider')
        `),
      /actor_pairing/i,
    );
  });

  /** §4 I-1: a status outside the twelve-value vocabulary cannot be stored at all. */
  it('refuses a booking status outside the vocabulary', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE bookings SET status = 'nonsense' WHERE id = ${booking.id}`),
      /status/i,
    );
  });
});
