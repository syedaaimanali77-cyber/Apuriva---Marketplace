import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { createBooking } from '@/lib/bookings/create';
import { completeBooking } from '@/lib/bookings/complete';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { driveToInProgress } from '@/lib/bookings/bookings-test-support';
import { authorizePayment } from './authorize';
import { registerDisputeGate } from './protection-window';
import { runPaymentSweep } from './sweep';
import {
  backdateProtectionWindow,
  bookingStatus,
  completionInstantOf,
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  setProtectionWindowHours,
  storedPayment,
  usePaymentIntegration,
  type BookingScenario,
} from './payments-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

/** A paid booking driven to `completed` by whichever party the caller names (AC-5a is symmetric). */
async function completedPaidBooking(
  scenario: BookingScenario,
  completedBy: 'customer' | 'provider',
): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  await authorizePayment(scenario.customer.userId, booking.id, freshKey());
  await driveToInProgress(scenario, booking.id);
  const actor = completedBy === 'customer' ? scenario.customer.userId : scenario.provider.userId;
  await completeBooking(actor, booking.id, completedBy);
  return booking.id;
}

describe.skipIf(!dbReachable)('protection window (spec 021 AC-5/AC-5a/AC-5b/AC-5c)', { timeout: SUITE_TIMEOUT_MS }, () => {
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
   * AC-5a — THE exactness assertion. The window starts at the `in_progress -> completed` history
   * instant, not at the moment the sweep observed it. If the sweep's own clock were used, this
   * would drift by however long the sweep lagged, and the deadline would silently move.
   */
  it('window starts at the completion history instant, and transitions the booking completed -> protected', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    const completedAt = await completionInstantOf(bookingId);
    expect(await bookingStatus(bookingId)).toBe('completed');

    // The sweep's counts are database-wide and this suite shares one with every other spec that
    // creates completed, captured bookings — so assert on THIS booking, which is the guarantee.
    await runPaymentSweep();

    const payment = await storedPayment(bookingId);
    expect(payment!.protection_state).toBe('held');
    expect(new Date(payment!.protection_window_started_at!).getTime()).toBe(completedAt.getTime());
    expect(payment!.protection_window_hours).toBe(48);
    expect(await bookingStatus(bookingId)).toBe('protected');
  });

  /** AC-5a — "regardless of whether the customer or the provider marked it complete". */
  it('opens the window identically when the CUSTOMER completed the booking', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'customer');

    const completedAt = await completionInstantOf(bookingId);
    await runPaymentSweep();

    const payment = await storedPayment(bookingId);
    expect(payment!.protection_state).toBe('held');
    expect(new Date(payment!.protection_window_started_at!).getTime()).toBe(completedAt.getTime());
    expect(await bookingStatus(bookingId)).toBe('protected');
  });

  /** AC-5 — a held payment is not released, and the booking is not settled, before the window ends. */
  it('a captured payment is not released before settlement', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    await runPaymentSweep();
    // The default 48-hour window has obviously not elapsed for a booking completed seconds ago.
    const second = await runPaymentSweep();
    expect(second.protectionReleased).toBe(0);

    expect((await storedPayment(bookingId))!.protection_state).toBe('held');
    expect(await bookingStatus(bookingId)).toBe('protected');
  });

  /** AC-5b — an elapsed, undisputed window releases protection and settles the booking. */
  it('an elapsed window with no dispute releases protection and settles the booking', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    await runPaymentSweep();
    await backdateProtectionWindow(bookingId, 49);

    const result = await runPaymentSweep();
    expect(result.protectionReleased).toBe(1);
    expect(result.protectionDisputed).toBe(0);

    expect((await storedPayment(bookingId))!.protection_state).toBe('released');
    expect(await bookingStatus(bookingId)).toBe('settled');
  });

  /** AC-5a — a configured duration wins over the 48-hour default, in both directions. */
  it('honours a configured window duration instead of the default', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    await runPaymentSweep();
    await setProtectionWindowHours(bookingId, 2);

    // 1 hour in, a 2-hour window has NOT elapsed — a 48-hour default would also not have, so
    // backdate past the configured duration but far short of the default to prove which one applies.
    await backdateProtectionWindow(bookingId, 1);
    expect((await runPaymentSweep()).protectionReleased).toBe(0);
    expect((await storedPayment(bookingId))!.protection_state).toBe('held');

    await backdateProtectionWindow(bookingId, 3);
    expect((await runPaymentSweep()).protectionReleased).toBe(1);
    expect((await storedPayment(bookingId))!.protection_state).toBe('released');
    expect(await bookingStatus(bookingId)).toBe('settled');
  });

  /**
   * AC-5c — an in-window dispute holds payout past the window's elapse, and the booking stays
   * `protected`: this spec never transitions a booking to `disputed`, which is spec 031's.
   */
  it('an open dispute holds protection past elapse and never transitions the booking to disputed', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    await runPaymentSweep();
    // Spec 031's port, registered as spec 031 will register it.
    registerDisputeGate(async (_tx, id) => ({ open: id === bookingId }));

    await backdateProtectionWindow(bookingId, 96);
    const result = await runPaymentSweep();

    expect(result.protectionDisputed).toBe(1);
    expect(result.protectionReleased).toBe(0);

    expect((await storedPayment(bookingId))!.protection_state).toBe('disputed');
    expect(await bookingStatus(bookingId)).toBe('protected');

    // And it stays blocked on every subsequent run, however long the window has been over.
    expect((await runPaymentSweep()).protectionReleased).toBe(0);
    expect(await bookingStatus(bookingId)).toBe('protected');
  });

  /** AC-5c — a dispute opened BEFORE the window elapses holds it immediately, not only at elapse. */
  it('holds a disputed payment even before the window elapses', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    await runPaymentSweep();
    // Scoped to THIS booking: the suite shares one database, so a gate that disputed everything
    // would also dispute held payments left by earlier tests and make the count meaningless.
    registerDisputeGate(async (_tx, id) => ({ open: id === bookingId }));

    // The window has NOT elapsed — a few seconds into a 48-hour window — and the dispute still wins.
    const payment = await storedPayment(bookingId);
    expect(payment!.protection_state).toBe('held');

    await runPaymentSweep();
    expect((await storedPayment(bookingId))!.protection_state).toBe('disputed');
    expect(await bookingStatus(bookingId)).toBe('protected');
  });

  /** AC-5 — protection never opens for a booking whose payment was never captured. */
  it('never protects a booking with no captured payment', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    // No payment at all: the booking stays `pending` and the sweep has nothing to protect HERE.
    // Asserted on this booking rather than on a database-wide count, which other suites also move.
    await runPaymentSweep();
    expect(await storedPayment(booking.id)).toBeUndefined();
    expect(await bookingStatus(booking.id)).toBe('pending');
  });

  /** The sweep is idempotent: re-running opens nothing new and releases nothing twice. */
  it('is idempotent across repeated runs', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await completedPaidBooking(scenario, 'provider');

    // Asserted on THIS booking's state and version rather than on database-wide counts: the test
    // database is shared with every other spec that creates completed, captured bookings, so a
    // global count was never the guarantee this test makes. Idempotency means the second run
    // changes nothing HERE — which an unchanged version proves exactly.
    await runPaymentSweep();
    const opened = (await storedPayment(bookingId))!;
    expect(opened.protection_state).toBe('held');

    await runPaymentSweep();
    const afterSecondOpen = (await storedPayment(bookingId))!;
    expect(afterSecondOpen.protection_state).toBe('held');
    expect(afterSecondOpen.version).toBe(opened.version);

    await backdateProtectionWindow(bookingId, 49);
    await runPaymentSweep();
    const released = (await storedPayment(bookingId))!;
    expect(released.protection_state).toBe('released');
    expect(await bookingStatus(bookingId)).toBe('settled');

    await runPaymentSweep();
    const afterSecondRelease = (await storedPayment(bookingId))!;
    expect(afterSecondRelease.protection_state).toBe('released');
    expect(afterSecondRelease.version).toBe(released.version);
    expect(await bookingStatus(bookingId)).toBe('settled');
  });
});
