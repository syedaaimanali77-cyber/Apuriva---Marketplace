import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { paymentAuthorizationWindowMinutes } from '@/lib/payments/sweep';
import { enterDemoEnvironment, isDatabaseReachable, stableNow } from '../demo-test-support';
import { provisionDemoSet, type ProvisionedDemoSet } from '../provision';

const dbReachable = await isDatabaseReachable();
const DAY = 24 * 60 * 60_000;

/**
 * Spec 045 fixtures vs spec 021 AC-9. A full-suite run showed `lib/payments/sweep.integration.test.ts` failing
 * demo `pending` bookings: sets provisioned for the tests' noon `stableNow()` wrote them hours in the past, so
 * they were already past the expiry window. This provisions for a `now` a whole day earlier, so the check
 * discriminates at any time of day, and asserts the sweep's own predicate — `status = 'pending'` and
 * `created_at` older than the window by the database clock — on these sets only. It deliberately does not call
 * the global `runPaymentSweep()`, which would also expire or lock other test files' rows.
 */
describe.skipIf(!dbReachable)('spec 045 fixtures are never eligible for spec 021 AC-9 pending-payment expiry', () => {
  let restore: () => void;
  const sets: ProvisionedDemoSet[] = [];

  beforeAll(async () => {
    restore = enterDemoEnvironment();
    const longAgo = new Date(stableNow().getTime() - DAY);
    sets.push(await provisionDemoSet('customer', { now: longAgo }));
    sets.push(await provisionDemoSet('provider', { now: longAgo }));
  }, 120_000);

  afterAll(() => restore?.());

  async function bookingsOf(set: ProvisionedDemoSet) {
    return queryRows<{ key: string; status: string; expired: boolean; fresh: boolean }>(
      getDb(),
      sql`SELECT b.status, k.key,
                 b.created_at < clock_timestamp() - make_interval(mins => ${paymentAuthorizationWindowMinutes()}) AS expired,
                 b.created_at >= clock_timestamp() - interval '10 minutes' AS fresh
            FROM bookings b
            JOIN (VALUES ${sql.join(Object.entries(set.bookingIds).map(([key, id]) => sql`(${key}, ${id}::uuid)`), sql`, `)}) AS k(key, id)
              ON k.id = b.id`,
    );
  }

  it('keeps a pending booking in every set (AC-2), none of them past the expiry window', async () => {
    for (const set of sets) {
      const pending = (await bookingsOf(set)).filter((booking) => booking.status === 'pending');
      expect(pending.length).toBeGreaterThan(0);
      for (const booking of pending) {
        expect(booking.expired).toBe(false);
        // Anchored to the provisioning instant, so it stays ineligible for most of the window, not just now.
        expect(booking.fresh).toBe(true);
      }
    }
  });

  it('leaves every other booking on the plan clock: only `pending` is re-anchored', async () => {
    for (const set of sets) {
      const others = (await bookingsOf(set)).filter((booking) => booking.status !== 'pending');
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((booking) => booking.expired)).toBe(true);
    }
  });
});
