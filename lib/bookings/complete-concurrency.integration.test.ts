import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import type { BookingDto } from '@/lib/types/bookings';
import { createBooking } from './create';
import { completeBooking } from './complete';
import { registerCompletionEvidenceGate, resetCompletionEvidenceGate } from './completion-evidence';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import {
  bookingHistory,
  createBookingBody,
  driveToInProgress,
  seedBookingScenario,
  seedStranger,
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

async function inProgressBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  await driveToInProgress(scenario, booking.id);
  return booking.id;
}

/**
 * Spec 020 §2 AC-9 / §3 "Concurrency rules" — simultaneous customer + provider completion.
 *
 * REAL CONCURRENCY, NOT MOCKED: each `completeBooking` opens its own transaction on its own pooled
 * connection, so the two genuinely compete for the booking row lock and the `(status, version)`
 * conditional update. No mock, spy or fake timer appears in this file.
 */
describe.skipIf(!dbReachable)('completion concurrency (spec 020 AC-9, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    resetRateLimitState();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    resetCompletionEvidenceGate();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('records exactly one transition and one history row, and the loser gets the completed booking', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    const results = await Promise.allSettled([
      completeBooking(scenario.customer.userId, bookingId, 'customer'),
      completeBooking(scenario.provider.userId, bookingId, 'provider'),
    ]);

    // AC-9: BOTH are valid requests, so neither is an error — the loser is an idempotent success.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      expect((result as PromiseFulfilledResult<BookingDto>).value.status).toBe('completed');
    }

    // Exactly one transition, exactly one history row, no corrupted state.
    const completions = (await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed');
    expect(completions).toHaveLength(1);
    expect(['customer', 'provider']).toContain(completions[0]!.actor_role);
    expect((await storedBooking(bookingId)).status).toBe('completed');
  });

  it('stays race-safe when both parties retry several times at once', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    const attempts = [
      ...Array.from({ length: 4 }, () => completeBooking(scenario.customer.userId, bookingId, 'customer')),
      ...Array.from({ length: 4 }, () => completeBooking(scenario.provider.userId, bookingId, 'provider')),
    ];
    const results = await Promise.allSettled(attempts);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /**
   * AC-9's second half, and the reason validation order is normative: an UNAUTHORIZED request is
   * rejected on its own merits even when the other party's concurrent request has already completed
   * the booking. Losing the race is an idempotent success only for a request that would otherwise
   * have succeeded.
   */
  it('an unauthorized caller is 404 even when a concurrent request already completed the booking', async () => {
    const scenario = await seedBookingScenario();
    const stranger = await seedStranger();
    const bookingId = await inProgressBooking(scenario);

    const results = await Promise.allSettled([
      completeBooking(scenario.provider.userId, bookingId, 'provider'),
      completeBooking(stranger.customer.userId, bookingId, 'customer'),
    ]);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect(((results[1] as PromiseRejectedResult).reason as ApiRouteError).code).toBe('BOOKING_NOT_FOUND');

    // And afterwards, with the booking already completed, the stranger is STILL refused.
    await expect(completeBooking(stranger.customer.userId, bookingId, 'customer')).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
    });
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /** The same rule for the evidence gate: an evidence-incomplete request never rides on the winner. */
  it('an evidence-incomplete request is 422 even when the booking is already completed', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    // The provider completes while the gate is permissive.
    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    // The customer now arrives with the gate demanding evidence they do not have. The booking is
    // already `completed`, but that must not buy them a free pass.
    registerCompletionEvidenceGate(async () => ({ required: true, satisfied: false }));
    await expect(completeBooking(scenario.customer.userId, bookingId, 'customer')).rejects.toMatchObject({
      code: 'COMPLETION_EVIDENCE_REQUIRED',
    });

    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /** Likewise the dwell guard: a too-early caller is rejected on its own merits. */
  it('a too-early request is 422 even when the booking is already completed', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    const { advanceBooking } = await import('./lifecycle');
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'arrived');
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'in_progress');

    // Dwell not yet elapsed for anyone.
    await expect(completeBooking(scenario.customer.userId, booking.id, 'customer')).rejects.toMatchObject({
      code: 'COMPLETION_TOO_EARLY',
    });
    expect((await storedBooking(booking.id)).status).toBe('in_progress');
  });
});
