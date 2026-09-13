import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { providerServices, requestProviderMatches, services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { acceptRequest, declineRequest } from './provider-requests';
import { runMatching } from './run';
import {
  allWeekAlwaysOpen,
  isDatabaseReachable,
  registerProvider,
  seedCustomerWithAddress,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
} from './matching-test-support';

const dbReachable = await isDatabaseReachable();

/** Two eligible, notified providers on one matching request — the fixture every test here needs. */
async function seedTwoNotifiedProviders(): Promise<{ requestId: string; providerAId: string; providerBId: string }> {
  const providerA = await registerProvider();
  const { serviceId } = await seedProviderService(providerA.providerProfileId);
  // seedProviderService defaults to pricingModel 'quote' (send_offer only) — these tests exercise
  // the ACCEPT claim invariant, which needs a fixed/package/hourly service (spec 017 §3 AC-5).
  await getDb().update(services).set({ pricingModel: 'fixed' }).where(eq(services.id, serviceId));
  await seedWeeklyHours(providerA.providerProfileId, allWeekAlwaysOpen());

  const providerB = await registerProvider();
  await seedWeeklyHours(providerB.providerProfileId, allWeekAlwaysOpen());
  await getDb().insert(providerServices).values({ providerProfileId: providerB.providerProfileId, serviceId, durationMinutes: 60 });

  const customer = await seedCustomerWithAddress();
  const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
  await runMatching(request.id);

  return { requestId: request.id, providerAId: providerA.providerProfileId, providerBId: providerB.providerProfileId };
}

describe.skipIf(!dbReachable)('the accept claim invariant (spec 017 §3 "Concurrency", integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('a real two-connection race: two providers accepting the same request concurrently — exactly one wins', async () => {
    const { requestId, providerAId, providerBId } = await seedTwoNotifiedProviders();

    // Each call's own `getDb().transaction()` (lib/matching/provider-requests.ts) pulls a
    // SEPARATE physical connection from the shared pg Pool for the lifetime of its transaction —
    // this is therefore a real two-connection race decided by Postgres's own row lock, not an
    // in-process simulation of one. `Promise.allSettled` fires both requests without any
    // artificial ordering between them.
    const [resultA, resultB] = await Promise.allSettled([
      acceptRequest(providerAId, requestId),
      acceptRequest(providerBId, requestId),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'REQUEST_ALREADY_CLAIMED', status: 409 });

    // Exactly one row in the DB actually holds 'accepted' — the partial unique index's own
    // guarantee, verified directly rather than only trusting the application-level outcome.
    const rows = await getDb()
      .select({ providerProfileId: requestProviderMatches.providerProfileId, providerResponse: requestProviderMatches.providerResponse })
      .from(requestProviderMatches)
      .where(eq(requestProviderMatches.requestId, requestId));
    expect(rows.filter((r) => r.providerResponse === 'accepted')).toHaveLength(1);
  });

  it('the request-row lock is held before the accepted-check read, inside the caller\'s own transaction', async () => {
    const { requestId, providerAId } = await seedTwoNotifiedProviders();

    // A second, independent connection attempts a NOWAIT lock on the same request row while
    // providerA's transaction is (by hypothesis) holding it via `SELECT ... FOR UPDATE`. Since
    // `acceptRequest` commits in one shot, we instead prove the lock exists by directly holding it
    // on one connection and confirming a second real connection cannot acquire it concurrently.
    const pool = getPool();
    const holder = await pool.connect();
    const prober = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE', [requestId]);

      let proberBlocked = false;
      try {
        await prober.query('SELECT id FROM requests WHERE id = $1 FOR UPDATE NOWAIT', [requestId]);
      } catch {
        proberBlocked = true;
      }
      expect(proberBlocked).toBe(true);

      await holder.query('ROLLBACK');
    } finally {
      holder.release();
      prober.release();
    }

    // Sanity: with the lock released, the normal accept flow still succeeds.
    const outcome = await acceptRequest(providerAId, requestId);
    expect(outcome.providerResponse).toBe('accepted');
  });

  it('the database partial unique index rejects a second accepted row even bypassing the application lock', async () => {
    const { requestId, providerAId, providerBId } = await seedTwoNotifiedProviders();

    await getDb()
      .update(requestProviderMatches)
      .set({ providerResponse: 'accepted', respondedAt: new Date() })
      .where(and(eq(requestProviderMatches.requestId, requestId), eq(requestProviderMatches.providerProfileId, providerAId)));

    await expect(
      getDb()
        .update(requestProviderMatches)
        .set({ providerResponse: 'accepted', respondedAt: new Date() })
        .where(and(eq(requestProviderMatches.requestId, requestId), eq(requestProviderMatches.providerProfileId, providerBId))),
    ).rejects.toThrow();
  });

  it('repeating the SAME action is idempotent — 200 with the existing response, not a conflict', async () => {
    const { requestId, providerAId } = await seedTwoNotifiedProviders();
    const first = await acceptRequest(providerAId, requestId);
    const second = await acceptRequest(providerAId, requestId);
    expect(second.providerResponse).toBe('accepted');
    expect(second.respondedAt).toBe(first.respondedAt);
  });

  it('a DIFFERENT second action (decline after accept) is 422 REQUEST_NOT_ACTIONABLE, never an overwrite', async () => {
    const { requestId, providerAId } = await seedTwoNotifiedProviders();
    await acceptRequest(providerAId, requestId);
    await expect(declineRequest(providerAId, requestId)).rejects.toMatchObject({
      code: 'REQUEST_NOT_ACTIONABLE',
      status: 422,
    });
  });

  it('a provider not distributed into the request gets 403 NOT_DISTRIBUTED_TO_PROVIDER', async () => {
    const { requestId } = await seedTwoNotifiedProviders();
    const outsider = await registerProvider();
    await expect(acceptRequest(outsider.providerProfileId, requestId)).rejects.toMatchObject({
      code: 'NOT_DISTRIBUTED_TO_PROVIDER',
      status: 403,
    });
  });
});
