import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { createBooking } from './create';
import { completeBooking } from './complete';
import { advanceBooking } from './lifecycle';
import { registerCompletionEvidenceGate, resetCompletionEvidenceGate } from './completion-evidence';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from './busy-intervals';
import { SPEC_020_TRANSITIONS } from './state-machine';
import {
  bookingHistory,
  createBookingBody,
  driveToInProgress,
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

/** A booking driven to `in_progress` with the dwell already satisfied. */
async function inProgressBooking(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  await driveToInProgress(scenario, booking.id);
  return booking.id;
}

/** Spec 020 §3 "Unilateral-completion safeguards" — AC-5, AC-8, AC-10, AC-11. */
describe.skipIf(!dbReachable)('booking completion (spec 020 AC-5/AC-8/AC-10/AC-11, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  /** AC-8 — the provider completes, with no confirmation from the customer anywhere. */
  it('the provider completes an in_progress booking without the customer\'s confirmation', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    const booking = await completeBooking(scenario.provider.userId, bookingId, 'provider');

    expect(booking.status).toBe('completed');
    const completion = (await bookingHistory(bookingId)).find((row) => row.to_status === 'completed')!;
    expect(completion.actor_role).toBe('provider');
    expect(completion.actor_user_id).toBe(scenario.provider.userId);
  });

  /** AC-8 — and the customer completes, with equal authority and no provider confirmation. */
  it('the customer completes an in_progress booking without the provider\'s confirmation', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    const booking = await completeBooking(scenario.customer.userId, bookingId, 'customer');

    expect(booking.status).toBe('completed');
    const completion = (await bookingHistory(bookingId)).find((row) => row.to_status === 'completed')!;
    expect(completion.actor_role).toBe('customer');
    expect(completion.actor_user_id).toBe(scenario.customer.userId);
  });

  /** Safeguard S7 — the completion and its actor are immediately readable by BOTH parties. */
  it('records the completing party so the other party can always see who completed it', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);
    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    const { loadBookingStatusHistory, requireBookingParticipant } = await import('./read');

    // The customer — the party who did NOT complete — sees the completion and its actor role.
    const asCustomer = await requireBookingParticipant(scenario.customer.userId, bookingId);
    expect(asCustomer.booking.status).toBe('completed');

    const history = await loadBookingStatusHistory(bookingId);
    const completion = history.find((row) => row.toStatus === 'completed')!;
    expect(completion.actorRole).toBe('provider');
    // §4: the role is exposed, never the counterparty's user id.
    expect(Object.keys(completion).sort()).toEqual(['actorRole', 'fromStatus', 'occurredAt', 'toStatus']);
  });

  it('a completion retry is an idempotent success, not a second attribution', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    await completeBooking(scenario.customer.userId, bookingId, 'customer');
    const again = await completeBooking(scenario.customer.userId, bookingId, 'customer');

    expect(again.status).toBe('completed');
    expect((await bookingHistory(bookingId)).filter((row) => row.to_status === 'completed')).toHaveLength(1);
  });

  /** AC-5 — the gate is consulted identically for BOTH parties (safeguard S5). */
  it('a gate reporting required-and-unsatisfied rejects the customer and the provider identically', async () => {
    registerCompletionEvidenceGate(async () => ({ required: true, satisfied: false }));

    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    const customerError = await expectError(
      () => completeBooking(scenario.customer.userId, bookingId, 'customer'),
      'COMPLETION_EVIDENCE_REQUIRED',
    );
    const providerError = await expectError(
      () => completeBooking(scenario.provider.userId, bookingId, 'provider'),
      'COMPLETION_EVIDENCE_REQUIRED',
    );

    expect(customerError.status).toBe(422);
    expect(providerError.status).toBe(422);
    // Nothing written by either attempt.
    expect((await storedBooking(bookingId)).status).toBe('in_progress');
    expect((await bookingHistory(bookingId)).some((row) => row.to_status === 'completed')).toBe(false);
  });

  /** AC-5 — a satisfied requirement lets either party through. */
  it('a gate reporting required-and-satisfied lets either party complete', async () => {
    registerCompletionEvidenceGate(async () => ({ required: true, satisfied: true }));

    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    expect((await completeBooking(scenario.provider.userId, bookingId, 'provider')).status).toBe('completed');
  });

  /** AC-5 — the SHIPPED DEFAULT: no service requires evidence until spec 028 adds the column. */
  it('the shipped default gate lets either party complete without evidence', async () => {
    const first = await seedBookingScenario();
    const second = await seedBookingScenario();

    expect((await completeBooking(first.customer.userId, await inProgressBooking(first), 'customer')).status).toBe(
      'completed',
    );
    expect((await completeBooking(second.provider.userId, await inProgressBooking(second), 'provider')).status).toBe(
      'completed',
    );
  });

  /** AC-11 safeguard S3 — the dwell, symmetric across both parties. */
  it('completion within 60 seconds of in_progress is 422 COMPLETION_TOO_EARLY for either party', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'arrived');
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'in_progress');
    // No dwell shift: the booking has only just started.

    const customerError = await expectError(
      () => completeBooking(scenario.customer.userId, booking.id, 'customer'),
      'COMPLETION_TOO_EARLY',
    );
    const providerError = await expectError(
      () => completeBooking(scenario.provider.userId, booking.id, 'provider'),
      'COMPLETION_TOO_EARLY',
    );

    for (const err of [customerError, providerError]) {
      expect(err.status).toBe(422);
      const retryAfter = (err.details as { retryAfterSeconds: number }).retryAfterSeconds;
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    expect((await storedBooking(booking.id)).status).toBe('in_progress');
  });

  it('completion just past the dwell succeeds', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'arrived');
    await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, booking.id, 'in_progress');
    await shiftInProgressSince(booking.id, 61);

    expect((await completeBooking(scenario.customer.userId, booking.id, 'customer')).status).toBe('completed');
  });

  /** §3 "Authorization matrix" — a non-participant never completes, and gets 404 rather than 403. */
  it('a non-participant cannot complete the booking', async () => {
    const scenario = await seedBookingScenario();
    const stranger = await seedStranger();
    const bookingId = await inProgressBooking(scenario);

    await expectError(() => completeBooking(stranger.customer.userId, bookingId, 'customer'), 'BOOKING_NOT_FOUND');
    await expectError(() => completeBooking(stranger.provider.userId, bookingId, 'provider'), 'BOOKING_NOT_FOUND');
    expect((await storedBooking(bookingId)).status).toBe('in_progress');
  });

  /** §3 — a participant acting in the OTHER party's mode is refused, so attribution is unambiguous. */
  it('a participant acting in the wrong mode is refused', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);

    await expectError(() => completeBooking(scenario.customer.userId, bookingId, 'provider'), 'BOOKING_NOT_FOUND');
    await expectError(() => completeBooking(scenario.provider.userId, bookingId, 'customer'), 'BOOKING_NOT_FOUND');
    expect((await storedBooking(bookingId)).status).toBe('in_progress');
  });

  /**
   * AC-10 — a disagreement never becomes an automatic dispute. Completion writes no dispute row and
   * no `disputed` transition; spec 031 owns the explicit, user-initiated path.
   */
  it('completion creates no dispute row and no transition to disputed', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);
    await completeBooking(scenario.provider.userId, bookingId, 'provider');

    const { rows } = (await getDb().execute(
      sql`SELECT COUNT(*)::int AS n FROM disputes WHERE booking_id = ${bookingId}`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(0);

    expect((await bookingHistory(bookingId)).some((row) => row.to_status === 'disputed')).toBe(false);
    expect(SPEC_020_TRANSITIONS.some(([, to]) => to === 'disputed')).toBe(false);
  });

  /** Safeguard S8 — `completed` is terminal in this spec; there is no un-complete. */
  it('nothing can move a completed booking on from within spec 020', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);
    await completeBooking(scenario.customer.userId, bookingId, 'customer');

    // No outgoing transition seeded by THIS spec, so even a raw UPDATE is refused by the spec 003
    // trigger. Two targets are deliberately absent from this list because the specs that own them
    // have now shipped and seed them in their own migrations, exactly as spec 020 always said they
    // would: `protected` (spec 021, §3 "Payment boundary") and `refunded` (spec 022, §4 "any →
    // refunded | 022 | spec 022's migration"). Every target below is still owned by a spec that has
    // not shipped — `cancelled` (023), `disputed` (031) — or by nobody at all (`in_progress`), and
    // `completed -> settled` stays unseeded because spec 021 reaches `settled` only from
    // `protected`. What this spec guarantees is unchanged and still asserted: no spec 020 code path
    // moves a completed booking anywhere, which `payment-boundary.test.ts` proves at source level.
    for (const target of ['in_progress', 'settled', 'cancelled', 'disputed']) {
      await expect(
        getDb().execute(sql`UPDATE bookings SET status = ${target} WHERE id = ${bookingId}`),
      ).rejects.toThrow();
    }
    expect((await storedBooking(bookingId)).status).toBe('completed');
  });

  /** §3 "Payment boundary" — reaching `completed` triggers nothing on the payment side. */
  it('completion creates no payment row and never reaches protected or settled', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await inProgressBooking(scenario);
    await completeBooking(scenario.customer.userId, bookingId, 'customer');

    const { rows } = (await getDb().execute(
      sql`SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = ${bookingId}`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(0);
    expect((await storedBooking(bookingId)).status).toBe('completed');
  });
});
