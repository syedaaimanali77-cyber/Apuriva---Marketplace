import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { getAvailabilitySummary } from '@/lib/availability/summary';
import { BOOKING_STATUSES } from '@/lib/db/schema';
import { countRows, enterDemoEnvironment, isDatabaseReachable, stableNow } from '../demo-test-support';
import { isDemoDisplayName, isUndeliverableDemoEmail } from '../identity';
import { provisionDemoSet, type ProvisionedDemoSet } from '../provision';

const dbReachable = await isDatabaseReachable();

/** The customer-visible request statuses the request state machine can reach (spec 045 §3.3). */
const REACHABLE_REQUEST_STATUSES = ['submitted', 'matching', 'offers_open', 'provider_selected', 'booking_created', 'cancelled'];
const OFFER_STATUSES = ['sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn'];

describe.skipIf(!dbReachable)('spec 045 AC-2 — a provisioned demo set spans every required entity and state', () => {
  let restore: () => void;
  const sets: Record<'customer' | 'provider', ProvisionedDemoSet> = {} as never;
  const now = stableNow();
  let catalogBefore: number;

  beforeAll(async () => {
    restore = enterDemoEnvironment();
    catalogBefore = (await countRows('categories')) + (await countRows('services')) + (await countRows('service_fields'));
    sets.customer = await provisionDemoSet('customer', { now });
    sets.provider = await provisionDemoSet('provider', { now });
  }, 120_000);

  afterAll(() => restore?.());

  for (const persona of ['customer', 'provider'] as const) {
    describe(`the ${persona} set`, () => {
      const set = () => sets[persona];

      it('every user is a demo user of this set, with a "(Demo)" name and an undeliverable email, and no phone', async () => {
        const users = await queryRows<{ is_demo: boolean; email: string; phone_number: string | null; display_name: string | null; business_name: string | null }>(
          getDb(),
          sql`SELECT u.is_demo, u.email, u.phone_number, cp.display_name, pp.business_name
                FROM users u
                JOIN customer_profiles cp ON cp.user_id = u.id
           LEFT JOIN provider_profiles pp ON pp.user_id = u.id
               WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(users.length).toBeGreaterThanOrEqual(6);
        for (const user of users) {
          expect(user.is_demo).toBe(true);
          expect(isUndeliverableDemoEmail(user.email)).toBe(true);
          expect(user.phone_number).toBeNull();
          expect(isDemoDisplayName(user.display_name)).toBe(true);
          if (user.business_name !== null) expect(isDemoDisplayName(user.business_name)).toBe(true);
        }
      });

      it('has bookings in every spec 020 status', async () => {
        const rows = await queryRows<{ status: string }>(
          getDb(),
          sql`SELECT DISTINCT b.status FROM bookings b
                JOIN customer_profiles cp ON cp.id = b.customer_profile_id
                JOIN users u ON u.id = cp.user_id
               WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(rows.map((row) => row.status).sort()).toEqual([...BOOKING_STATUSES].sort());
      });

      it('has requests in every reachable customer-visible status, and offers in every status including expired', async () => {
        const requests = await queryRows<{ status: string }>(
          getDb(),
          sql`SELECT DISTINCT r.status FROM requests r
                JOIN customer_profiles cp ON cp.id = r.customer_profile_id
                JOIN users u ON u.id = cp.user_id
               WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(requests.map((row) => row.status).sort()).toEqual([...REACHABLE_REQUEST_STATUSES].sort());

        const offers = await queryRows<{ status: string }>(
          getDb(),
          sql`SELECT DISTINCT o.status FROM offers o
                JOIN provider_profiles pp ON pp.id = o.provider_profile_id
                JOIN users u ON u.id = pp.user_id
               WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(offers.map((row) => row.status).sort()).toEqual([...OFFER_STATUSES].sort());
      });

      it('has providers with packages and ready portfolio placeholders, in each availability state', async () => {
        const providers = await queryRows<{ id: string; packages: number; portfolio: number }>(
          getDb(),
          sql`SELECT pp.id,
                     (SELECT count(*)::int FROM service_packages sp WHERE sp.provider_profile_id = pp.id) AS packages,
                     (SELECT count(*)::int FROM file_assets fa
                       WHERE fa.context_type = 'portfolio' AND fa.context_id = pp.id AND fa.status = 'ready'
                         AND fa.visibility = 'public' AND fa.scan_outcome = 'clean') AS portfolio
                FROM provider_profiles pp JOIN users u ON u.id = pp.user_id
               WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(providers.length).toBeGreaterThanOrEqual(3);
        for (const provider of providers) {
          expect(provider.packages).toBeGreaterThan(0);
          expect(provider.portfolio).toBeGreaterThan(0);
        }
        const states = await Promise.all(providers.map((provider) => getAvailabilitySummary(provider.id, now)));
        expect(new Set(states.map((state) => state.state))).toEqual(new Set(['available', 'busy', 'unavailable']));
      });

      it('has reviews, and inbox-only notifications for the persona (no delivery is queued)', async () => {
        const [reviews] = await queryRows<{ n: number }>(
          getDb(),
          sql`SELECT count(*)::int AS n FROM reviews r JOIN users u ON u.id = r.author_user_id WHERE u.demo_set_id = ${set().setId}`,
        );
        expect(reviews!.n).toBeGreaterThanOrEqual(3);

        const [notifications] = await queryRows<{ n: number; deliveries: number }>(
          getDb(),
          sql`SELECT count(*)::int AS n,
                     (SELECT count(*)::int FROM notification_deliveries d WHERE d.notification_id IN
                        (SELECT id FROM notifications WHERE recipient_user_id = ${set().personaUserId})) AS deliveries
                FROM notifications WHERE recipient_user_id = ${set().personaUserId}`,
        );
        expect(notifications!.n).toBeGreaterThanOrEqual(3);
        expect(notifications!.deliveries).toBe(0);
      });

      it('relates only users of the same set', async () => {
        const [cross] = await queryRows<{ n: number }>(
          getDb(),
          sql`SELECT count(*)::int AS n FROM bookings b
                JOIN customer_profiles cp ON cp.id = b.customer_profile_id JOIN users cu ON cu.id = cp.user_id
                JOIN provider_profiles pp ON pp.id = b.provider_profile_id JOIN users pu ON pu.id = pp.user_id
               WHERE (cu.demo_set_id = ${set().setId} OR pu.demo_set_id = ${set().setId})
                 AND cu.demo_set_id IS DISTINCT FROM pu.demo_set_id`,
        );
        expect(cross!.n).toBe(0);
      });
    });
  }

  it('references the eight categories and services seeded by migration 0006 and never inserts a catalog row (D-5)', async () => {
    const after = (await countRows('categories')) + (await countRows('services')) + (await countRows('service_fields'));
    expect(after).toBe(catalogBefore);
    const [used] = await queryRows<{ categories: number }>(
      getDb(),
      sql`SELECT count(DISTINCT s.category_id)::int AS categories FROM requests r
            JOIN services s ON s.id = r.service_id
            JOIN customer_profiles cp ON cp.id = r.customer_profile_id JOIN users u ON u.id = cp.user_id
           WHERE u.demo_set_id IN (${sets.customer.setId}, ${sets.provider.setId})`,
    );
    expect(used!.categories).toBe(8);
  });
});
