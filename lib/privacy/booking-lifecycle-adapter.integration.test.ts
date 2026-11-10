import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { createBooking } from '@/lib/bookings/create';
import { completeBooking } from '@/lib/bookings/complete';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import {
  createBookingBody,
  driveToInProgress,
  seedBookingScenario,
  seedStranger,
} from '@/lib/bookings/bookings-test-support';
import { generateExportPayload } from './export';
import { hasActiveBooking } from './booking-lifecycle-adapter';
import { seedBooking, seedUser } from './test-support';

const dbReachable = await isDatabaseReachable();

/**
 * The Spec 020 suite builds fixtures through the REAL spec 015→019 path (registration, matching,
 * offer, accept), which is deliberate but not fast. Under the full suite's concurrent worker threads
 * that legitimately exceeds vitest.config's 15s default — the same CPU-contention effect that file
 * already documents for component tests. Each test passes well inside this budget.
 */
const SUITE_TIMEOUT_MS = 60_000;

// One pool for the whole file: ending it inside either describe block would break the other.
afterAll(async () => {
  await getPool().end();
});

/**
 * Spec 008 AC-4's dependency on the booking status machine, isolated to this one adapter
 * (lib/privacy/booking-lifecycle-adapter.ts) so lib/privacy/deletion.ts never encodes
 * booking-status knowledge itself. These cases predate spec 020 and are kept unchanged: spec 020's
 * vocabulary had to satisfy them, not replace them.
 */
describe.skipIf(!dbReachable)('booking-lifecycle-adapter (spec 008 AC-4, integration)', () => {
  it('is false with no bookings at all', async () => {
    const userId = await seedUser();
    expect(await hasActiveBooking(userId)).toBe(false);
  });

  it('is true when the user is the customer on a non-resolved booking', async () => {
    const userId = await seedUser();
    await seedBooking(userId, 'in_progress');
    expect(await hasActiveBooking(userId)).toBe(true);
  });

  it.each(['completed', 'settled', 'cancelled', 'refunded', 'failed'])(
    'is false once the only booking is in the provisional resolved status "%s"',
    async (status) => {
      const userId = await seedUser();
      await seedBooking(userId, status);
      expect(await hasActiveBooking(userId)).toBe(false);
    },
  );

  it.each(['pending', 'confirmed', 'provider_en_route', 'arrived', 'in_progress', 'protected', 'disputed'])(
    'is true while the only booking is in the not-yet-resolved status "%s"',
    async (status) => {
      const userId = await seedUser();
      await seedBooking(userId, status);
      expect(await hasActiveBooking(userId)).toBe(true);
    },
  );

  it('is true when one booking is resolved but another is not', async () => {
    const userId = await seedUser();
    await seedBooking(userId, 'completed');
    await seedBooking(userId, 'in_progress');
    expect(await hasActiveBooking(userId)).toBe(true);
  });

  it("never counts another user's booking", async () => {
    const userId = await seedUser();
    const otherUserId = await seedUser();
    await seedBooking(otherUserId, 'in_progress');
    expect(await hasActiveBooking(userId)).toBe(false);
  });
});

/**
 * Spec 020 §2 AC-13 / §4 "Retention and privacy" — the same boundary exercised through REAL bookings
 * created by spec 020's own path, now that the status vocabulary exists.
 */
describe.skipIf(!dbReachable)(
  'booking privacy through real bookings (spec 020 AC-13, integration)',
  { timeout: SUITE_TIMEOUT_MS },
  () => {
    beforeEach(() => {
      resetRateLimitState();
      registerBookingBusyIntervals();
    });

    afterEach(() => {
      resetBusyIntervalLoader();
      resetBookingBusyIntervalsRegistration();
    });

    it('hasActiveBooking is true for a live booking, for BOTH participants', async () => {
      const scenario = await seedBookingScenario();
      await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

      expect(await hasActiveBooking(scenario.customer.userId)).toBe(true);
      expect(await hasActiveBooking(scenario.provider.userId)).toBe(true);
    });

    it('hasActiveBooking is false once the booking is completed', async () => {
      const scenario = await seedBookingScenario();
      const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
      await driveToInProgress(scenario, booking.id);
      await completeBooking(scenario.customer.userId, booking.id, 'customer');

      expect(await hasActiveBooking(scenario.customer.userId)).toBe(false);
      expect(await hasActiveBooking(scenario.provider.userId)).toBe(false);
    });

    it("exports the caller's bookings with schedule, price and history — and no idempotency data", async () => {
      const scenario = await seedBookingScenario();
      const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

      const payload = await generateExportPayload(scenario.customer.userId);
      const exported = payload.bookings.find((row) => row.id === booking.id)!;

      expect(exported).toBeDefined();
      expect(exported.status).toBe('confirmed');
      expect(exported.serviceId).toBe(scenario.serviceId);
      expect(exported.scheduledAt).toBe(booking.scheduledAt);
      expect(exported.scheduledTimezone).toBe('Asia/Karachi');
      expect(exported.durationMinutes).toBe(60);
      expect(exported.priceAmountMinorUnits).toBe(320_000);
      expect(exported.currencyCode).toBe('PKR');
      expect(exported.statusHistory.map((row) => row.toStatus)).toEqual(['pending', 'confirmed']);
      expect(exported.statusHistory.every((row) => row.actorRole === 'customer')).toBe(true);

      const serialized = JSON.stringify(payload.bookings);
      expect(serialized).not.toMatch(/idempotency|fingerprint/i);
      expect(serialized).not.toContain(scenario.provider.userId);
      expect(serialized).not.toContain(scenario.customer.userId);
      expect(Object.keys(exported).sort()).toEqual(
        [
          'createdAt',
          'currencyCode',
          'durationMinutes',
          'id',
          'priceAmountMinorUnits',
          'scheduledAt',
          'scheduledTimezone',
          'serviceId',
          'status',
          'statusHistory',
        ].sort(),
      );
    });

    it('the provider exports the same booking from their own side', async () => {
      const scenario = await seedBookingScenario();
      const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

      const payload = await generateExportPayload(scenario.provider.userId);
      expect(payload.bookings.map((row) => row.id)).toContain(booking.id);
    });

    it('a stranger exports none of it', async () => {
      const scenario = await seedBookingScenario();
      const stranger = await seedStranger();
      const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

      const payload = await generateExportPayload(stranger.provider.userId);
      expect(payload.bookings.map((row) => row.id)).not.toContain(booking.id);
    });

    /**
     * §4: a booking is a financial/audit record. Nothing in spec 020 deletes or anonymizes one, and
     * every FK into `bookings` is `onDelete: 'restrict'` (spec 003) while its history is append-only,
     * so a delete is refused outright.
     */
    it('a booking row cannot be deleted, and its history survives', async () => {
      const scenario = await seedBookingScenario();
      const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));

      await expect(getDb().execute(sql`DELETE FROM bookings WHERE id = ${booking.id}`)).rejects.toThrow();

      const { rows } = (await getDb().execute(
        sql`SELECT COUNT(*)::int AS n FROM bookings_status_history WHERE booking_id = ${booking.id}`,
      )) as unknown as { rows: { n: number }[] };
      expect(rows[0]!.n).toBe(2);
    });
  },
);
