import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import type { SlotUnavailableDetails } from '@/lib/types/bookings';
import { ALTERNATIVE_LOOKAHEAD_DAYS, MAX_ALTERNATIVES } from './alternatives';
import { createBooking } from './create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import {
  countBookings,
  createBookingBody,
  futureLocalSlot,
  requestStatusOf,
  seedBookingScenario,
  seedRivalForSameProvider,
} from './bookings-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * These suites build their fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker
 * threads that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect
 * that file already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;

async function expectSlotConflict(fn: () => Promise<unknown>): Promise<SlotUnavailableDetails> {
  try {
    await fn();
  } catch (err) {
    const error = err as ApiRouteError;
    expect(error.code).toBe('SLOT_NO_LONGER_AVAILABLE');
    expect(error.status).toBe(422);
    expect(error.details).toBeDefined();
    return error.details as unknown as SlotUnavailableDetails;
  }
  throw new Error('expected SLOT_NO_LONGER_AVAILABLE to be thrown');
}

/** Occupies the provider's time at `startAt` with a booking created through the real path. */
async function occupy(scenario: Awaited<ReturnType<typeof seedBookingScenario>>, startAt: Date): Promise<void> {
  await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId, startAt));
}

/** Spec 020 §3 "Slot-conflict alternatives" — AC-2. */
describe.skipIf(!dbReachable)('slot conflict and alternatives (spec 020 AC-2, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  it('a slot taken after acceptance yields 422 SLOT_NO_LONGER_AVAILABLE and writes nothing', async () => {
    const blocker = await seedBookingScenario();
    const startAt = futureLocalSlot(2);
    await occupy(blocker, startAt);

    // A second customer, SAME provider, overlapping time — built through the real path.
    const contender = await seedRivalForSameProvider(blocker);

    const details = await expectSlotConflict(() =>
      createBooking(contender.customer.userId, randomUUID(), createBookingBody(contender.offerId, startAt)),
    );

    expect(details.requestedStartAt).toBe(startAt.toISOString());
    expect(details.durationMinutes).toBe(60);
    expect(details.scheduledTimezone).toBe('Asia/Karachi');
    // Nothing written, and the customer's position is exactly as it was.
    expect(await countBookings(contender.offerId)).toBe(0);
    expect(await requestStatusOf(contender.requestId)).toBe('provider_selected');
  });

  it('details carry up to three earliest-first alternatives at the requested time-of-day', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(3);
    await occupy(scenario, startAt);

    // Same provider, a second customer wanting the same instant.
    const contender = await seedRivalForSameProvider(scenario);

    const details = await expectSlotConflict(() =>
      createBooking(contender.customer.userId, randomUUID(), createBookingBody(contender.offerId, startAt)),
    );

    expect(details.alternatives.length).toBeGreaterThan(0);
    expect(details.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);

    // Ordering: strictly ascending.
    const times = details.alternatives.map((alt) => new Date(alt.startAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // Every alternative is the customer's OWN requested time-of-day, on a LATER local date, inside
    // the published horizon.
    const requestedTimeOfDay = details.alternatives[0]!.localTimeOfDay;
    for (const alt of details.alternatives) {
      expect(alt.localTimeOfDay).toBe(requestedTimeOfDay);
      expect(alt.scheduledTimezone).toBe('Asia/Karachi');
      expect(new Date(alt.startAt).getTime()).toBeGreaterThan(startAt.getTime());
      const daysAhead = (new Date(alt.startAt).getTime() - startAt.getTime()) / 86_400_000;
      expect(daysAhead).toBeLessThanOrEqual(ALTERNATIVE_LOOKAHEAD_DAYS + 1);
    }
  });

  it('an alternative can be re-submitted with a new Idempotency-Key and succeeds', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(4);
    await occupy(scenario, startAt);

    const contender = await seedRivalForSameProvider(scenario);

    const details = await expectSlotConflict(() =>
      createBooking(contender.customer.userId, randomUUID(), createBookingBody(contender.offerId, startAt)),
    );
    expect(details.alternatives.length).toBeGreaterThan(0);

    // The whole point of AC-2: the returned value goes straight back in as `scheduledAt`.
    const chosen = details.alternatives[0]!;
    const { booking, created } = await createBooking(
      contender.customer.userId,
      randomUUID(),
      { offerId: contender.offerId, scheduledAt: chosen.startAt },
    );

    expect(created).toBe(true);
    expect(booking.status).toBe('confirmed');
    expect(new Date(booking.scheduledAt).toISOString()).toBe(new Date(chosen.startAt).toISOString());
  });

  it('returns nextAvailableDate and an empty alternatives list when nothing qualifies', async () => {
    const scenario = await seedBookingScenario();
    // A provider with no weekly hours at all can never satisfy a candidate.
    await getDb().execute(
      sql`DELETE FROM provider_availabilities WHERE provider_profile_id = ${scenario.provider.providerProfileId}`,
    );

    const details = await expectSlotConflict(() =>
      createBooking(
        scenario.customer.userId,
        randomUUID(),
        createBookingBody(scenario.offerId, futureLocalSlot(5)),
      ),
    );

    expect(details.alternatives).toEqual([]);
    // Never an empty body — the fallback field is always present, even when it is null.
    expect(Object.hasOwn(details, 'nextAvailableDate')).toBe(true);
  });

  it('a scheduled time already in the past is treated as a lost slot, with alternatives', async () => {
    const scenario = await seedBookingScenario();

    const details = await expectSlotConflict(() =>
      createBooking(
        scenario.customer.userId,
        randomUUID(),
        createBookingBody(scenario.offerId, new Date(Date.now() - 60 * 60_000)),
      ),
    );

    expect(details.requestedStartAt).toBeDefined();
    expect(await countBookings(scenario.offerId)).toBe(0);
  });

  /**
   * Spec 016 §3 restricts a busy interval's `sourceId` to the OWNING PROVIDER. Spec 020 catches
   * `SLOT_OVERLAP` and raises its own error rather than forwarding spec 016's message, so no booking
   * id, window boundary, buffer or booking count can reach the customer.
   */
  it('never leaks spec 016 sourceId, booking ids, counts, buffers or schedule internals', async () => {
    const scenario = await seedBookingScenario();
    const startAt = futureLocalSlot(6);
    await occupy(scenario, startAt);

    const contender = await seedRivalForSameProvider(scenario);

    let thrown: ApiRouteError | undefined;
    try {
      await createBooking(contender.customer.userId, randomUUID(), createBookingBody(contender.offerId, startAt));
    } catch (err) {
      thrown = err as ApiRouteError;
    }

    const serialized = JSON.stringify({ message: thrown!.message, details: thrown!.details });
    // The blocking booking's id is the `sourceId` spec 016 would have named.
    const { rows } = (await getDb().execute(
      sql`SELECT id FROM bookings WHERE offer_id = ${scenario.offerId}`,
    )) as unknown as { rows: { id: string }[] };
    expect(serialized).not.toContain(rows[0]!.id);
    expect(serialized).not.toContain('reference');
    expect(serialized).not.toMatch(/sourceId/i);
    expect(serialized).not.toMatch(/startMinute|endMinute|buffer/i);
    // The published `details` shape and nothing more.
    expect(Object.keys(thrown!.details!).sort()).toEqual(
      ['alternatives', 'durationMinutes', 'nextAvailableDate', 'requestedStartAt', 'scheduledTimezone'].sort(),
    );
    // And each alternative carries only the four published fields.
    for (const alt of (thrown!.details as unknown as SlotUnavailableDetails).alternatives) {
      expect(Object.keys(alt).sort()).toEqual(['localDate', 'localTimeOfDay', 'scheduledTimezone', 'startAt']);
    }
  });
});
