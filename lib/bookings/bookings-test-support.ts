import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { addDays, utcToZoned, zonedDateTimeToUtc } from '@/lib/availability/timezone';
import { acceptOffer } from '@/lib/offers/decide';
import { queryRows } from '@/lib/offers/db';
import { seedOfferScenario, sendOffer } from '@/lib/offers/offers-test-support';
import type { ProviderFixture, TestSession } from '@/lib/offers/offers-test-support';
import type { BookingStatus } from '@/lib/types/bookings';
import { registerBookingBusyIntervals } from './busy-intervals';

export {
  authenticatedRequest,
  isDatabaseReachable,
  sessionGet,
  sessionMutate,
  type ProviderFixture,
  type TestSession,
} from '@/lib/offers/offers-test-support';

/**
 * Spec 020 §6 fixtures.
 *
 * Every scenario is built through the REAL spec 015→019 path: a submitted request run through spec
 * 017's `runMatching`, a genuine spec 018 offer, and spec 018's own `acceptOffer` — so the
 * `accepted` offer and the `provider_selected` request a booking is created from are never faked.
 * That is what makes these suites a test of spec 020 against the approved specs rather than against
 * a convenient fixture.
 *
 * Timing strategy: no sleeps, no mocked clock. Scheduled times are placed relative to the real
 * clock, and the dwell/early-start fixtures move a history row or `scheduled_at` relative to the
 * DATABASE clock in one statement — exactly the approach spec 018's `shiftOfferWindow` established.
 */
export interface BookingScenario {
  customer: TestSession & { addressId: string };
  provider: ProviderFixture;
  requestId: string;
  serviceId: string;
  offerId: string;
  /** The request's `preferred_at`, i.e. the default `scheduledAt` for `POST /bookings`. */
  preferredAt: Date;
}

/** Minutes from now that a scenario's `preferred_at` is placed at, unless overridden. */
const DEFAULT_LEAD_MINUTES = 1;

/**
 * A customer with an accepted offer from an always-available provider, and a request sitting in
 * `provider_selected` — i.e. exactly the state `POST /api/v1/bookings` expects.
 *
 * `leadMinutes` places `preferred_at` relative to now: the default of 1 minute is in the future
 * (so creation passes step 11) AND inside the 60-minute early-start grace (so the provider can
 * immediately go en route). Pass a larger value to exercise AC-11's `BOOKING_NOT_STARTABLE_YET`.
 */
export async function seedBookingScenario(options?: {
  leadMinutes?: number;
  durationMinutes?: number;
  priceAmountMinorUnits?: number;
  /** false leaves the offer `sent` — spec 018's trigger forbids un-accepting one after the fact. */
  accept?: boolean;
}): Promise<BookingScenario> {
  registerBookingBusyIntervals();

  const scenario = await seedOfferScenario({ providerCount: 1 });
  const provider = scenario.providers[0]!;

  const preferredAt = new Date(Date.now() + (options?.leadMinutes ?? DEFAULT_LEAD_MINUTES) * 60_000);
  await getDb().execute(sql`
    UPDATE requests SET preferred_at = ${preferredAt.toISOString()}::timestamptz, preferred_timezone = 'Asia/Karachi'
     WHERE id = ${scenario.requestId}
  `);

  const offer = await sendOffer(provider, scenario.requestId, {
    priceAmountMinorUnits: options?.priceAmountMinorUnits ?? 320_000,
    estimatedDurationMinutes: options?.durationMinutes ?? 60,
  });
  if (options?.accept !== false) await acceptOffer(scenario.customer.userId, offer.id, randomUUID());

  resetRateLimitState();
  return {
    customer: scenario.customer,
    provider,
    requestId: scenario.requestId,
    serviceId: scenario.serviceId,
    offerId: offer.id,
    preferredAt,
  };
}

/**
 * A SECOND customer holding an accepted offer from the SAME provider — the fixture every
 * double-booking and slot-conflict test needs.
 *
 * Built entirely through the real path (new request → `runMatching` → spec 018 offer → spec 018
 * accept). It deliberately does NOT re-point an existing offer at another provider: spec 019's
 * `offers_terms_immutable_trg` forbids changing a non-draft offer's provider or price, and working
 * around that would be testing a state the application can never produce.
 */
export async function seedRivalForSameProvider(scenario: BookingScenario): Promise<BookingScenario> {
  const { runMatching } = await import('@/lib/matching/run');
  const { seedCustomerWithAddress, seedSubmittedRequest } = await import('@/lib/matching/matching-test-support');

  resetRateLimitState();
  const customer = await seedCustomerWithAddress();
  const request = await seedSubmittedRequest(customer.userId, scenario.serviceId, customer.addressId);
  await runMatching(request.id);

  const preferredAt = new Date(scenario.preferredAt.getTime());
  await getDb().execute(sql`
    UPDATE requests SET preferred_at = ${preferredAt.toISOString()}::timestamptz, preferred_timezone = 'Asia/Karachi'
     WHERE id = ${request.id}
  `);

  const offer = await sendOffer(scenario.provider, request.id, {
    priceAmountMinorUnits: 410_000,
    estimatedDurationMinutes: 60,
  });
  await acceptOffer(customer.userId, offer.id, randomUUID());

  resetRateLimitState();
  return {
    customer,
    provider: scenario.provider,
    requestId: request.id,
    serviceId: scenario.serviceId,
    offerId: offer.id,
    preferredAt,
  };
}

/**
 * A registered customer and a registered provider who are NOT parties to any booking.
 *
 * Much cheaper than a second `seedBookingScenario`: the "non-participant gets 404" tests only need
 * somebody else's credentials, not a whole second request/offer/matching chain, and building one
 * was the main reason those tests ran long enough to hit the suite timeout under load.
 */
export async function seedStranger(): Promise<{ customer: TestSession; provider: ProviderFixture }> {
  const { registerCustomer, registerProvider } = await import('@/lib/matching/matching-test-support');
  resetRateLimitState();
  const customer = await registerCustomer();
  resetRateLimitState();
  const provider = await registerProvider();
  resetRateLimitState();
  return { customer, provider };
}

/** The zone every fixture provider schedules in (`registerProvider`'s default). */
const FIXTURE_TIMEZONE = 'Asia/Karachi';

/**
 * A future instant at a SAFE local time of day in the fixture provider's zone.
 *
 * Picking `Date.now() + N hours` is not safe: spec 016 R5 keeps every availability window inside one
 * local date, so a 60-minute candidate starting at, say, 23:30 local spills past midnight, falls
 * outside every window, and is correctly refused with `SLOT_OVERLAP`. That makes any test using a
 * raw hour offset pass or fail depending on the wall-clock time the suite happens to run at.
 * Anchoring to a fixed local hour removes the flake without weakening anything.
 *
 * `dayOffset` is whole local days ahead (1 = tomorrow); `hour` is the local hour, defaulting to
 * 10:00, which leaves room for any duration these suites use.
 */
export function futureLocalSlot(dayOffset: number, hour = 10): Date {
  const todayLocal = utcToZoned(new Date(), FIXTURE_TIMEZONE).date;
  return zonedDateTimeToUtc(addDays(todayLocal, dayOffset), hour * 60, FIXTURE_TIMEZONE);
}

export function createBookingBody(offerId: string, scheduledAt?: Date): Record<string, unknown> {
  return scheduledAt ? { offerId, scheduledAt: scheduledAt.toISOString() } : { offerId };
}

export async function storedBooking(bookingId: string) {
  const [row] = await queryRows<{
    status: BookingStatus;
    offer_id: string;
    request_id: string;
    service_id: string;
    customer_profile_id: string;
    provider_profile_id: string;
    address_id: string;
    scheduled_at: Date;
    scheduled_timezone: string;
    duration_minutes: number;
    price_amount_minor_units: number;
    price_currency_code: string;
    idempotency_key: string;
    version: number;
  }>(
    getDb(),
    sql`SELECT status, offer_id, request_id, service_id, customer_profile_id, provider_profile_id, address_id,
               scheduled_at, scheduled_timezone, duration_minutes, price_amount_minor_units,
               price_currency_code, idempotency_key, version
          FROM bookings WHERE id = ${bookingId}`,
  );
  return row!;
}

export async function bookingHistory(bookingId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_role: string; actor_user_id: string | null }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, actor_user_id
          FROM bookings_status_history WHERE booking_id = ${bookingId}
         ORDER BY occurred_at, created_at`,
  );
}

export async function countBookings(offerId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(getDb(), sql`SELECT COUNT(*) AS n FROM bookings WHERE offer_id = ${offerId}`);
  return Number(row!.n);
}

/**
 * Asserts that a database constraint or trigger rejected `fn`, matching the POSTGRES message.
 *
 * Drizzle wraps driver errors, so `err.message` is only "Failed query: ..." — the real message
 * (`Booking ... terms are immutable`, `... append-only`, a constraint name) lives on `err.cause`.
 * Asserting on the wrapper would pass for ANY failure, including the query being malformed, so
 * these suites unwrap deliberately.
 */
export async function expectDatabaseRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const cause = (err as { cause?: { message?: string; constraint?: string } }).cause;
    const text = `${cause?.message ?? ''} ${cause?.constraint ?? ''} ${(err as Error).message}`;
    if (pattern.test(text)) return;
    throw new Error(`expected a database rejection matching ${pattern} but got: ${text}`);
  }
  throw new Error(`expected a database rejection matching ${pattern}, but the statement succeeded`);
}

export async function requestStatusOf(requestId: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM requests WHERE id = ${requestId}`);
  return row!.status;
}

/**
 * Places the `arrived -> in_progress` history row `secondsAgo` before the DATABASE clock, so AC-11's
 * dwell rule can be crossed without sleeping.
 *
 * `bookings_status_history` is append-only (`bookings_status_history_append_only_trg`), which is the
 * point of safeguard S6 — so this fixture DELETEs nothing and UPDATEs nothing. It disables the
 * trigger for the length of one transaction instead, a privilege no application path has and which
 * cannot leak: `ALTER TABLE ... DISABLE TRIGGER` is transaction-local here because the surrounding
 * transaction re-enables it before committing.
 */
export async function shiftInProgressSince(bookingId: string, secondsAgo: number): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE bookings_status_history DISABLE TRIGGER bookings_status_history_append_only_trg`);
    await tx.execute(sql`
      UPDATE bookings_status_history
         SET occurred_at = clock_timestamp() - (${secondsAgo} * interval '1 second')
       WHERE booking_id = ${bookingId} AND to_status = 'in_progress'
    `);
    await tx.execute(sql`ALTER TABLE bookings_status_history ENABLE TRIGGER bookings_status_history_append_only_trg`);
  });
}

/**
 * Drives a booking from `confirmed` to `in_progress` through the REAL provider routes, then clears
 * the dwell so it can be completed — the common starting point for AC-5/AC-8/AC-9 suites.
 */
export async function driveToInProgress(scenario: BookingScenario, bookingId: string): Promise<void> {
  const { advanceBooking } = await import('./lifecycle');
  await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, bookingId, 'arrived');
  await advanceBooking(scenario.provider.userId, scenario.provider.providerProfileId, bookingId, 'in_progress');
  await shiftInProgressSince(bookingId, 120);
}
