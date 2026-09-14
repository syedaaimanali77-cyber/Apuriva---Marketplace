import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { queryRows } from '@/lib/offers/db';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { SLOT_RELEASING_BOOKING_STATUSES } from '@/lib/bookings/busy-intervals';
import { bookingHistory } from '@/lib/bookings/bookings-test-support';
import { authorizePayment } from './authorize';
import { SANDBOX_DECLINE_AMOUNT_SUFFIX } from './provider';
import { DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES, paymentAuthorizationWindowMinutes, runPaymentSweep } from './sweep';
import {
  amountWithSandboxSuffix,
  backdateBookingCreation,
  bookingStatus,
  createBookingBody,
  freshKey,
  paymentHistory,
  resetPaymentIntegration,
  seedBookingScenario,
  storedPayment,
  usePaymentIntegration,
} from './payments-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

describe.skipIf(!dbReachable)('pending-payment expiry sweep (spec 021 AC-9)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('defaults the authorization window to 30 minutes', () => {
    expect(DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES).toBe(30);
    expect(paymentAuthorizationWindowMinutes()).toBe(30);
  });

  /**
   * AC-9 — resolves spec 020 §8 open question 7. An unpaid booking cannot sit `pending` forever
   * holding a provider's time; `failed` is in spec 020's SLOT_RELEASING set, so the slot is handed
   * back by the existing machinery rather than by anything this spec invented.
   */
  it('an unpaid pending booking past the window transitions to failed and releases the slot', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    expect(await bookingStatus(booking.id)).toBe('pending');
    // Not yet expired: the sweep must leave a fresh booking strictly alone.
    expect((await runPaymentSweep()).bookingsFailed).toBe(0);
    expect(await bookingStatus(booking.id)).toBe('pending');

    await backdateBookingCreation(booking.id, 31);
    const result = await runPaymentSweep();

    expect(result.bookingsFailed).toBe(1);
    expect(await bookingStatus(booking.id)).toBe('failed');
    expect(SLOT_RELEASING_BOOKING_STATUSES).toContain('failed');
  });

  /** §3 "Booking boundary" — always through spec 020's primitive, always attributed to the system. */
  it('attributes the expiry transition to the system, with no actor user', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await backdateBookingCreation(booking.id, 31);
    await runPaymentSweep();

    const history = await bookingHistory(booking.id);
    const expiry = history.at(-1)!;
    expect([expiry.from_status, expiry.to_status]).toEqual(['pending', 'failed']);
    expect(expiry.actor_role).toBe('system');
    expect(expiry.actor_user_id).toBeNull();
  });

  /** A booking whose payment was declined is closed out along with its payment row. */
  it('closes out a non-terminal payment when its booking expires', async () => {
    const scenario = await seedBookingScenario({
      priceAmountMinorUnits: amountWithSandboxSuffix(SANDBOX_DECLINE_AMOUNT_SUFFIX),
    });
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey()).catch(() => undefined);

    expect((await storedPayment(booking.id))!.status).toBe('created');

    await backdateBookingCreation(booking.id, 31);
    await runPaymentSweep();

    expect(await bookingStatus(booking.id)).toBe('failed');
    expect((await storedPayment(booking.id))!.status).toBe('failed');

    const history = await paymentHistory(booking.id);
    const last = history.at(-1)!;
    expect([last.from_status, last.to_status]).toEqual(['created', 'failed']);
    expect(last.actor_role).toBe('system');
    expect(last.actor_user_id).toBeNull();
  });

  /** A booking that DID pay is confirmed, not pending, so the expiry pass must never touch it. */
  it('never expires a booking whose payment succeeded', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    await backdateBookingCreation(booking.id, 120);
    await runPaymentSweep();

    expect(await bookingStatus(booking.id)).toBe('confirmed');
    expect((await storedPayment(booking.id))!.status).toBe('captured');
  });

  /** Idempotent and retry-safe: the next minute's run is the retry, and it fails nothing twice. */
  it('is idempotent across repeated runs', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await backdateBookingCreation(booking.id, 31);

    expect((await runPaymentSweep()).bookingsFailed).toBe(1);
    expect((await runPaymentSweep()).bookingsFailed).toBe(0);

    const failures = (await bookingHistory(booking.id)).filter((row) => row.to_status === 'failed');
    expect(failures).toHaveLength(1);
  });

  /** §3 — the transition is seeded, so the spec 003 trigger permits it at the database too. */
  it('seeds the three booking transitions this spec owns', async () => {
    const rows = await queryRows<{ from_status: string; to_status: string }>(
      getDb(),
      sql`SELECT from_status, to_status FROM bookings_status_transitions
           WHERE (from_status, to_status) IN (('pending','failed'),('completed','protected'),('protected','settled'))
           ORDER BY from_status, to_status`,
    );
    expect(rows).toEqual([
      { from_status: 'completed', to_status: 'protected' },
      { from_status: 'pending', to_status: 'failed' },
      { from_status: 'protected', to_status: 'settled' },
    ]);
  });

  /** §4 — and the payment graph 0017 seeds is exactly the nine transitions this spec performs. */
  it('seeds exactly the nine payment transitions this spec performs', async () => {
    const rows = await queryRows<{ count: string }>(
      getDb(),
      sql`SELECT COUNT(*)::text AS count FROM payments_status_transitions`,
    );
    expect(Number(rows[0]!.count)).toBe(9);

    const refundRows = await queryRows<{ count: string }>(
      getDb(),
      sql`SELECT COUNT(*)::text AS count FROM payments_status_transitions
           WHERE to_status IN ('refunded','partially_refunded')`,
    );
    expect(Number(refundRows[0]!.count)).toBe(0);
  });
});
