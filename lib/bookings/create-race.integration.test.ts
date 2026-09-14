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
  countBookings,
  createBookingBody,
  expectDatabaseRejection,
  futureLocalSlot,
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

/**
 * Spec 020 §2 AC-12 / §3 "Concurrency rules" — double-booking prevention.
 *
 * REAL CONCURRENCY, NOT MOCKED. Each `createBooking` call opens its own transaction, and
 * `getDb().transaction()` checks out its own connection from the pool — so two concurrent calls
 * genuinely compete for the `provider_profiles` row lock spec 016's `reserveProviderSlot` takes.
 * That lock, held inside the writing transaction and taken BEFORE the overlap read, is the whole
 * mechanism (spec 016 AC-2); this suite proves it rather than assuming it.
 *
 * Spec 020 deliberately does NOT introduce a second concurrency architecture: it reuses spec 016's
 * primitive exactly as that spec's §3 "Interface with spec 020" specifies.
 */
describe.skipIf(!dbReachable)('booking creation races (spec 020 AC-12, integration)', { timeout: SUITE_TIMEOUT_MS }, () => {
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

  it('two overlapping creations for one provider yield exactly one booking and one 422', async () => {
    const first = await seedBookingScenario();
    const rival = await seedRivalForSameProvider(first);
    const startAt = futureLocalSlot(7);

    const results = await Promise.allSettled([
      createBooking(first.customer.userId, randomUUID(), createBookingBody(first.offerId, startAt)),
      createBooking(rival.customer.userId, randomUUID(), createBookingBody(rival.offerId, startAt)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as ApiRouteError).code).toBe('SLOT_NO_LONGER_AVAILABLE');

    // Exactly one booking occupies the provider at that instant.
    const { rows } = (await getDb().execute(sql`
      SELECT COUNT(*)::int AS n FROM bookings
       WHERE provider_profile_id = ${first.provider.providerProfileId}
         AND scheduled_at = ${startAt.toISOString()}::timestamptz
    `)) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(1);
  });

  it('two concurrent creations with the same key and body produce exactly one booking', async () => {
    const scenario = await seedBookingScenario();
    const key = randomUUID();
    const body = createBookingBody(scenario.offerId);

    const results = await Promise.allSettled([
      createBooking(scenario.customer.userId, key, body),
      createBooking(scenario.customer.userId, key, body),
    ]);

    // Both may succeed (one creating, one replaying) — what must never happen is two rows.
    expect(await countBookings(scenario.offerId)).toBe(1);
    const ids = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createBooking>>> => r.status === 'fulfilled')
      .map((r) => r.value.booking.id);
    expect(new Set(ids).size).toBeLessThanOrEqual(1);
  });

  it('two concurrent creations with different keys on one offer produce exactly one booking', async () => {
    const scenario = await seedBookingScenario();

    const results = await Promise.allSettled([
      createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
      createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId)),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await countBookings(scenario.offerId)).toBe(1);

    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ApiRouteError).code).toBe('BOOKING_ALREADY_EXISTS');
  });

  /** §4 I-3: the database backstop, proven by bypassing the application check entirely. */
  it('bookings_offer_id_uq rejects a second booking for one offer even bypassing the application', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

    await expectDatabaseRejection(
      () =>
        getDb().execute(sql`
          INSERT INTO bookings (offer_id, status, request_id, service_id, customer_profile_id,
                                provider_profile_id, address_id, scheduled_at, scheduled_timezone,
                                duration_minutes, price_amount_minor_units, price_currency_code,
                                idempotency_key, idempotency_fingerprint)
          SELECT b.offer_id, 'pending', b.request_id, b.service_id, b.customer_profile_id,
                 b.provider_profile_id, b.address_id, b.scheduled_at, b.scheduled_timezone,
                 b.duration_minutes, b.price_amount_minor_units, b.price_currency_code,
                 'bypass-key', 'bypass-fingerprint'
            FROM bookings b WHERE b.id = ${booking.id}
        `),
      /bookings_offer_id_uq/i,
    );

    expect(await countBookings(scenario.offerId)).toBe(1);
  });

  /** §4 I-4: idempotency is enforced by an index, so the MCP path collides identically (§3). */
  it('bookings_customer_idempotency_key_uq rejects a duplicate key for one customer', async () => {
    const scenario = await seedBookingScenario();
    const rival = await seedRivalForSameProvider(scenario);
    const key = randomUUID();

    await createBooking(scenario.customer.userId, key, createBookingBody(scenario.offerId));

    // Same customer profile, different offer, same key — forced past the application check.
    await expectDatabaseRejection(
      () =>
        getDb().execute(sql`
          INSERT INTO bookings (offer_id, status, request_id, service_id, customer_profile_id,
                                provider_profile_id, address_id, scheduled_at, scheduled_timezone,
                                duration_minutes, price_amount_minor_units, price_currency_code,
                                idempotency_key, idempotency_fingerprint)
          SELECT ${rival.offerId}, 'pending', b.request_id, b.service_id, b.customer_profile_id,
                 b.provider_profile_id, b.address_id, b.scheduled_at + interval '3 days', b.scheduled_timezone,
                 b.duration_minutes, b.price_amount_minor_units, b.price_currency_code,
                 ${key}, 'other-fingerprint'
            FROM bookings b WHERE b.offer_id = ${scenario.offerId}
        `),
      /bookings_customer_idempotency_key_uq/i,
    );
  });
});
