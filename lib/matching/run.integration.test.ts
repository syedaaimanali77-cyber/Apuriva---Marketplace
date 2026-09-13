import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerServices, requestProviderMatches, requests, services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { DEFAULT_MATCHING_POOL_SIZE } from './weights';
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

describe.skipIf(!dbReachable)('runMatching (spec 017 §3 AC-1..AC-4, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('AC-1/AC-2/AC-4: an eligible provider is ranked and notified when the pool covers everyone', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const result = await runMatching(request.id);
    expect(result.eligibleCount).toBe(1);
    expect(result.excludedCount).toBe(0);
    expect(result.notifiedProviderProfileIds).toEqual([provider.providerProfileId]);
    expect(result.poolSize).toBe(DEFAULT_MATCHING_POOL_SIZE);

    const [row] = await getDb()
      .select()
      .from(requestProviderMatches)
      .where(eq(requestProviderMatches.requestId, request.id));
    expect(row!.eligible).toBe(true);
    expect(row!.rank).toBe(1);
    expect(row!.scoreMicros).not.toBeNull();
    expect(row!.notifiedAt).not.toBeNull();
    expect(row!.exclusionReason).toBeNull();

    // Status transition: submitted -> matching (spec 017's own seeded transition).
    const [updatedRequest] = await getDb().select({ status: requests.status }).from(requests).where(eq(requests.id, request.id));
    expect(updatedRequest!.status).toBe('matching');
  });

  it('AC-1: an ineligible provider is recorded excluded, with a reason, and never ranked', async () => {
    // No weekly hours seeded at all -> unavailable (E3), for an unscheduled request.
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const result = await runMatching(request.id);
    expect(result.eligibleCount).toBe(0);
    expect(result.excludedCount).toBe(1);
    expect(result.notifiedProviderProfileIds).toEqual([]);

    const [row] = await getDb()
      .select()
      .from(requestProviderMatches)
      .where(eq(requestProviderMatches.requestId, request.id));
    expect(row!.eligible).toBe(false);
    expect(row!.exclusionReason).toBe('unavailable');
    expect(row!.rank).toBeNull();
    expect(row!.scoreMicros).toBeNull();
  });

  it('AC-4: re-running matching for the same request is idempotent — no duplicate rows, no widened notified set', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const first = await runMatching(request.id);
    const second = await runMatching(request.id);

    expect(second.notifiedProviderProfileIds).toEqual(first.notifiedProviderProfileIds);

    const rows = await getDb().select().from(requestProviderMatches).where(eq(requestProviderMatches.requestId, request.id));
    expect(rows).toHaveLength(1); // never duplicated by the (request_id, provider_profile_id) unique index
  });

  it('AC-4: never notifies the entire eligible set once it exceeds the pool size', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());

    // A tiny pool size (2) with 3 eligible providers total (the seeded one + 2 more sharing the
    // same service) forces the "more eligible than N" branch.
    await getDb().update(services).set({ matchingPoolSize: 2 }).where(eq(services.id, serviceId));

    for (let i = 0; i < 2; i += 1) {
      const extra = await registerProvider();
      await seedWeeklyHours(extra.providerProfileId, allWeekAlwaysOpen());
      await getDb().insert(providerServices).values({ providerProfileId: extra.providerProfileId, serviceId, durationMinutes: 60 });
    }

    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    const result = await runMatching(request.id);
    expect(result.eligibleCount).toBe(3);
    expect(result.poolSize).toBe(2);
    expect(result.notifiedProviderProfileIds).toHaveLength(2);
  });

  it("AC-4: notifies ALL eligible providers when fewer than the pool size exist (not an error)", async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    // Only 1 eligible provider vs. the default pool of 10.
    const result = await runMatching(request.id);
    expect(result.eligibleCount).toBe(1);
    expect(result.notifiedProviderProfileIds).toHaveLength(1);
  });

  it('AC-3: a brand-new provider (no terminal response yet) is eligible for exploration accounting', async () => {
    const provider = await registerProvider();
    const { serviceId } = await seedProviderService(provider.providerProfileId);
    await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
    const customer = await seedCustomerWithAddress();
    const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);

    await runMatching(request.id);
    const [row] = await getDb().select().from(requestProviderMatches).where(eq(requestProviderMatches.requestId, request.id));
    // Solo eligible provider in an under-filled pool: notified organically, not via exploration
    // (exploration only applies once the pool is exceeded) — exploration_boosted stays false.
    expect(row!.explorationBoosted).toBe(false);
  });

  it('throws NOT_FOUND for an unknown request id', async () => {
    await expect(runMatching('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
