import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getBusyIntervalLoader, resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { reserveProviderSlot } from '@/lib/availability/reserve';
import { putWeeklySchedule } from '@/lib/availability/schedule';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from './create';
import { completeBooking } from './complete';
import {
  loadBookingBusyIntervals,
  registerBookingBusyIntervals,
  resetBookingBusyIntervalsRegistration,
  SLOT_OCCUPYING_BOOKING_STATUSES,
  SLOT_RELEASING_BOOKING_STATUSES,
} from './busy-intervals';
import { createBookingBody, driveToInProgress, futureLocalSlot, seedBookingScenario } from './bookings-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * These suites build their fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker
 * threads that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect
 * that file already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;

/**
 * Spec 020 §4 "Busy-interval loader (the spec 016 contract)".
 *
 * Registering this loader is what makes spec 016's already-shipped machinery live against real
 * bookings — its AC-2 double-booking prevention, and its §8 risk #6 "a provider edits their schedule
 * under a confirmed booking", which was inert until now. This suite proves both, with NO change to
 * any file under `lib/availability/**`.
 */
describe.skipIf(!dbReachable)('booking busy-interval port (spec 016 contract, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  it('registers itself as spec 016\'s loader, replacing the inert default', () => {
    expect(getBusyIntervalLoader()).toBe(loadBookingBusyIntervals);
  });

  it('declares an occupying set that partitions the whole status vocabulary', () => {
    const all = [...SLOT_OCCUPYING_BOOKING_STATUSES, ...SLOT_RELEASING_BOOKING_STATUSES].sort();
    expect(all).toEqual(
      [
        'pending',
        'confirmed',
        'provider_en_route',
        'arrived',
        'in_progress',
        'completed',
        'protected',
        'settled',
        'disputed',
        'cancelled',
        'refunded',
        'failed',
      ].sort(),
    );
    // No status is in both halves.
    expect(new Set(all).size).toBe(12);
  });

  it('returns a confirmed booking as a half-open interval with the booking id as sourceId', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(8);
    const { booking } = await createBooking(
      scenario.customer.userId,
      randomUUID(),
      createBookingBody(scenario.offerId, startAt),
    );

    const intervals = await loadBookingBusyIntervals(getDb(), scenario.provider.providerProfileId, {
      from: new Date(startAt.getTime() - 3_600_000),
      to: new Date(startAt.getTime() + 3 * 3_600_000),
    });

    const mine = intervals.find((interval) => interval.sourceId === booking.id)!;
    expect(mine).toBeDefined();
    expect(mine.startAt.toISOString()).toBe(startAt.toISOString());
    expect(mine.endAt.toISOString()).toBe(new Date(startAt.getTime() + 60 * 60_000).toISOString());
    expect(mine.serviceId).toBe(scenario.serviceId);
  });

  it('makes an existing booking block reserveProviderSlot for the same provider', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(9);
    await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId, startAt));

    await expect(
      getDb().transaction(async (tx) =>
        reserveProviderSlot(tx, {
          providerProfileId: scenario.provider.providerProfileId,
          serviceId: scenario.serviceId,
          startAt,
          durationMinutes: 60,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SLOT_OVERLAP' });
  });

  it('a completed booking still occupies its time, so history is never re-sold', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await driveToInProgress(scenario, booking.id);
    await completeBooking(scenario.customer.userId, booking.id, 'customer');

    const intervals = await loadBookingBusyIntervals(getDb(), scenario.provider.providerProfileId, {
      from: new Date(scenario.preferredAt.getTime() - 3_600_000),
      to: new Date(scenario.preferredAt.getTime() + 3 * 3_600_000),
    });
    expect(intervals.some((interval) => interval.sourceId === booking.id)).toBe(true);
  });

  it('a released booking no longer occupies its time', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(10);
    const { booking } = await createBooking(
      scenario.customer.userId,
      randomUUID(),
      createBookingBody(scenario.offerId, startAt),
    );

    // Spec 023 owns the `-> cancelled` transition, so this suite writes the status directly (with
    // the transition trigger disabled for one transaction) purely to prove the LOADER's partition.
    // No spec 020 code path can perform this change — that is the point of not seeding it.
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE bookings DISABLE TRIGGER bookings_status_transition_trg`);
      await tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${booking.id}`);
      await tx.execute(sql`ALTER TABLE bookings ENABLE TRIGGER bookings_status_transition_trg`);
    });

    const intervals = await loadBookingBusyIntervals(getDb(), scenario.provider.providerProfileId, {
      from: new Date(startAt.getTime() - 3_600_000),
      to: new Date(startAt.getTime() + 3 * 3_600_000),
    });
    expect(intervals.some((interval) => interval.sourceId === booking.id)).toBe(false);
  });

  /**
   * Spec 016 §8 risk #6, live for the first time: a provider cannot edit their schedule in a way
   * that would strand an already-confirmed booking. `lib/availability/schedule.ts` is unchanged —
   * it reaches this behaviour purely through the registered port.
   */
  it('blocks a provider schedule edit that would strand a confirmed booking', async () => {
    const scenario = await seedBookingScenario();
    await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    // Narrow the schedule to a single hour that cannot contain the booking's time.
    let thrown: ApiRouteError | undefined;
    try {
      await putWeeklySchedule(scenario.provider.providerProfileId, {
        timezone: 'Asia/Karachi',
        entries: [{ dayOfWeek: 0, startMinute: 0, endMinute: 60 }],
      });
    } catch (err) {
      thrown = err as ApiRouteError;
    }

    expect(thrown?.code).toBe('SLOT_OVERLAP');
  });
});
