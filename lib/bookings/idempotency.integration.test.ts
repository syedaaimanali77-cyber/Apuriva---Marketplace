import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from './create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import { countBookings, createBookingBody, futureLocalSlot, seedBookingScenario } from './bookings-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * These suites build their fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker
 * threads that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect
 * that file already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;

/**
 * Spec 020 §2 AC-3 — master spec §132.6's non-negotiable "no duplicate bookings on retries", named
 * in §115's critical test examples. Mandatory, not optional (§6).
 */
describe.skipIf(!dbReachable)('booking idempotency (spec 020 AC-3, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  it('the same key and body returns the original booking with created:false and exactly one row', async () => {
    const scenario = await seedBookingScenario();
    const key = randomUUID();
    const body = createBookingBody(scenario.offerId);

    const first = await createBooking(scenario.customer.userId, key, body);
    const second = await createBooking(scenario.customer.userId, key, body);
    const third = await createBooking(scenario.customer.userId, key, body);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.booking.id).toBe(first.booking.id);
    expect(third.booking.id).toBe(first.booking.id);
    expect(await countBookings(scenario.offerId)).toBe(1);
  });

  it('a replay is byte-identical to the original booking, not a re-derived one', async () => {
    const scenario = await seedBookingScenario();
    const key = randomUUID();
    const body = createBookingBody(scenario.offerId);

    const first = await createBooking(scenario.customer.userId, key, body);
    const replay = await createBooking(scenario.customer.userId, key, body);

    expect(replay.booking).toEqual(first.booking);
  });

  it('the same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing new', async () => {
    const scenario = await seedBookingScenario();
    const key = randomUUID();

    await createBooking(scenario.customer.userId, key, createBookingBody(scenario.offerId));

    try {
      await createBooking(
        scenario.customer.userId,
        key,
        createBookingBody(scenario.offerId, futureLocalSlot(12)),
      );
      throw new Error('expected IDEMPOTENCY_KEY_CONFLICT');
    } catch (err) {
      expect((err as ApiRouteError).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect((err as ApiRouteError).status).toBe(409);
    }
    expect(await countBookings(scenario.offerId)).toBe(1);
  });

  it('a different key on the same offer is 409 BOOKING_ALREADY_EXISTS naming the booking', async () => {
    const scenario = await seedBookingScenario();
    const first = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    try {
      await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
      throw new Error('expected BOOKING_ALREADY_EXISTS');
    } catch (err) {
      expect((err as ApiRouteError).code).toBe('BOOKING_ALREADY_EXISTS');
      expect((err as ApiRouteError).details).toMatchObject({ bookingId: first.booking.id });
    }
    expect(await countBookings(scenario.offerId)).toBe(1);
  });

  /** §3: the key is scoped per customer by `bookings_customer_idempotency_key_uq`, never globally. */
  it('two different customers may use the same idempotency key', async () => {
    const a = await seedBookingScenario();
    const b = await seedBookingScenario();
    const sharedKey = randomUUID();

    const first = await createBooking(a.customer.userId, sharedKey, createBookingBody(a.offerId));
    const second = await createBooking(b.customer.userId, sharedKey, createBookingBody(b.offerId));

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.booking.id).not.toBe(first.booking.id);
  });

  /** A reordered body must fingerprint identically — `idempotencyFingerprint` sorts keys. */
  it('treats a body whose properties are in a different order as the same request', async () => {
    const scenario = await seedBookingScenario();
    const key = randomUUID();
    const when = futureLocalSlot(13);

    const first = await createBooking(scenario.customer.userId, key, {
      offerId: scenario.offerId,
      scheduledAt: when.toISOString(),
    });
    const replay = await createBooking(scenario.customer.userId, key, {
      scheduledAt: when.toISOString(),
      offerId: scenario.offerId,
    });

    expect(replay.created).toBe(false);
    expect(replay.booking.id).toBe(first.booking.id);
  });
});
