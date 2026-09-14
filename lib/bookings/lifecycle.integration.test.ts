import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from './create';
import { advanceBooking } from './lifecycle';
import { completeBooking } from './complete';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import {
  bookingHistory,
  createBookingBody,
  expectDatabaseRejection,
  seedBookingScenario,
  seedStranger,
  shiftInProgressSince,
  storedBooking,
  type BookingScenario,
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

async function newBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  return booking.id;
}

/** Spec 020 §3 "Lifecycle transitions" — AC-4, AC-6, AC-7, AC-11. */
describe.skipIf(!dbReachable)('booking lifecycle (spec 020 AC-4/AC-6/AC-7/AC-11, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  it('progresses confirmed -> provider_en_route -> arrived -> in_progress, one action and one history row each', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);
    const { userId, providerProfileId } = scenario.provider;

    expect((await advanceBooking(userId, providerProfileId, bookingId, 'provider_en_route')).status).toBe('provider_en_route');
    expect((await advanceBooking(userId, providerProfileId, bookingId, 'arrived')).status).toBe('arrived');
    expect((await advanceBooking(userId, providerProfileId, bookingId, 'in_progress')).status).toBe('in_progress');

    const history = await bookingHistory(bookingId);
    expect(history.map((row) => row.to_status)).toEqual([
      'pending',
      'confirmed',
      'provider_en_route',
      'arrived',
      'in_progress',
    ]);
    // AC-4: every lifecycle row is attributed to the PROVIDER who acted.
    for (const row of history.slice(2)) {
      expect(row.actor_role).toBe('provider');
      expect(row.actor_user_id).toBe(userId);
    }
  });

  /** AC-4: the "on my way" step is optional. */
  it('confirmed -> arrived succeeds without the en-route step', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);

    const booking = await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, bookingId, 'arrived');
    expect(booking.status).toBe('arrived');
    expect((await bookingHistory(bookingId)).map((r) => `${r.from_status}->${r.to_status}`)).toContain('confirmed->arrived');
  });

  it('is naturally idempotent — repeating an action returns the current booking, not an error', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);
    const { userId, providerProfileId } = scenario.provider;

    await advanceBooking(userId, providerProfileId, bookingId, 'arrived');
    const again = await advanceBooking(userId, providerProfileId, bookingId, 'arrived');

    expect(again.status).toBe('arrived');
    expect((await bookingHistory(bookingId)).filter((r) => r.to_status === 'arrived')).toHaveLength(1);
  });

  it('rejects an out-of-sequence transition with 409 INVALID_STATUS_TRANSITION', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);
    const { userId, providerProfileId } = scenario.provider;

    // `confirmed -> in_progress` skips `arrived`.
    const err = await expectError(
      () => advanceBooking(userId, providerProfileId, bookingId, 'in_progress'),
      'INVALID_STATUS_TRANSITION',
    );
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ currentStatus: 'confirmed' });
    expect((await storedBooking(bookingId)).status).toBe('confirmed');
  });

  it('rejects completing a booking that is not in progress', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);

    await expectError(
      () => completeBooking(scenario.customer.userId, bookingId, 'customer'),
      'INVALID_STATUS_TRANSITION',
    );
    expect((await storedBooking(bookingId)).status).toBe('confirmed');
  });

  /**
   * AC-6's second line of defence: the spec 003 `bookings_status_transition_trg` rejects a pair
   * absent from `bookings_status_transitions` even when application code is bypassed entirely.
   */
  it('a raw UPDATE bypassing application code is rejected by the database trigger', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE bookings SET status = 'in_progress' WHERE id = ${bookingId}`),
      /Invalid bookings status transition/i,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE bookings SET status = 'completed' WHERE id = ${bookingId}`),
      /Invalid bookings status transition/i,
    );
    // And the transitions spec 021/023/031 own are equally unreachable from here.
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${bookingId}`),
      /Invalid bookings status transition/i,
    );
    expect((await storedBooking(bookingId)).status).toBe('confirmed');
  });

  it('a non-owner provider cannot advance the booking and gets 404, not 403', async () => {
    const scenario = await seedBookingScenario();
    // Only somebody else's credentials are needed here, not a second whole booking chain.
    const stranger = await seedStranger();
    const bookingId = await newBooking(scenario);

    const err = await expectError(
      () => advanceBooking(stranger.provider.userId, stranger.provider.providerProfileId, bookingId, 'arrived'),
      'BOOKING_NOT_FOUND',
    );
    expect(err.status).toBe(404);
  });

  it('the customer cannot drive the provider lifecycle actions', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);

    await expectError(
      () => advanceBooking(scenario.customer.userId, scenario.provider.providerProfileId, bookingId, 'arrived'),
      'BOOKING_NOT_FOUND',
    );
  });

  /** AC-11 safeguard S4 — the early-start guard, on the database clock. */
  it('en-route and arrived more than 60 minutes before scheduled_at are 422 BOOKING_NOT_STARTABLE_YET', async () => {
    const scenario = await seedBookingScenario({ leadMinutes: 24 * 60 });
    const bookingId = await newBooking(scenario);
    const { userId, providerProfileId } = scenario.provider;

    const err = await expectError(
      () => advanceBooking(userId, providerProfileId, bookingId, 'provider_en_route'),
      'BOOKING_NOT_STARTABLE_YET',
    );
    expect(err.status).toBe(422);
    expect(typeof (err.details as { startableFrom?: string }).startableFrom).toBe('string');

    await expectError(() => advanceBooking(userId, providerProfileId, bookingId, 'arrived'), 'BOOKING_NOT_STARTABLE_YET');
    expect((await storedBooking(bookingId)).status).toBe('confirmed');
  });

  it('within the grace window the provider may start immediately', async () => {
    // Scheduled 30 minutes out: inside the 60-minute grace.
    const scenario = await seedBookingScenario({ leadMinutes: 30 });
    const bookingId = await newBooking(scenario);

    const booking = await advanceBooking(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      'provider_en_route',
    );
    expect(booking.status).toBe('provider_en_route');
  });

  /**
   * AC-7 — the whole chain is driven by explicit authenticated provider actions. Each transition
   * carries a real actor; nothing in this spec can advance a booking without one.
   */
  it('every status change is attributable to a participant action', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);
    const { userId, providerProfileId } = scenario.provider;

    await advanceBooking(userId, providerProfileId, bookingId, 'arrived');
    await advanceBooking(userId, providerProfileId, bookingId, 'in_progress');
    await shiftInProgressSince(bookingId, 120);
    await completeBooking(scenario.customer.userId, bookingId, 'customer');

    const history = await bookingHistory(bookingId);
    expect(history).toHaveLength(5);
    for (const row of history) {
      expect(row.actor_user_id).not.toBeNull();
      expect(['customer', 'provider']).toContain(row.actor_role);
    }
    // No `system` actor appears anywhere: that is spec 021's, and spec 020 never writes one.
    expect(history.some((row) => row.actor_role === 'system')).toBe(false);
  });

  /** §3 optimistic concurrency — a stale `expectedVersion` is 409 CONFLICT, not a silent overwrite. */
  it('a stale expectedVersion is rejected by the transition primitive', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await newBooking(scenario);
    const { applyBookingTransition } = await import('./state-machine');

    const stored = await storedBooking(bookingId);
    const result = await applyBookingTransition(getDb(), {
      bookingId,
      from: 'confirmed',
      to: 'arrived',
      actorRole: 'provider',
      actorUserId: scenario.provider.userId,
      expectedVersion: stored.version + 99,
    });

    expect(result.applied).toBe(false);
    expect(result.currentStatus).toBe('confirmed');
    expect(result.currentVersion).toBe(stored.version);
  });
});
