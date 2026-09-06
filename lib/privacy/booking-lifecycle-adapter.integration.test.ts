import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { hasActiveBooking } from './booking-lifecycle-adapter';
import { seedBooking, seedUser } from './test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 008 AC-4's dependency on spec 020/028's (not-yet-implemented) booking status machine,
 * isolated to this one adapter (lib/privacy/booking-lifecycle-adapter.ts) so lib/privacy/
 * deletion.ts never encodes booking-status knowledge itself.
 */
describe.skipIf(!dbReachable)('booking-lifecycle-adapter (spec 008 AC-4, integration)', () => {
  const pool = getPool();

  afterAll(async () => {
    await pool.end();
  });

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
