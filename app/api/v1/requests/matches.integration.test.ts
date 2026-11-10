import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { providerServices } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { runMatching } from '@/lib/matching/run';
import { grantRole, registerAdmin, registerAdminWithPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { GET as GET_MATCHES } from './[id]/matches/route';
import {
  allWeekAlwaysOpen,
  isDatabaseReachable,
  registerCustomer,
  registerProvider,
  seedCustomerWithAddress,
  seedProviderService,
  seedSubmittedRequest,
  seedWeeklyHours,
  sessionGet,
} from '@/lib/matching/matching-test-support';

const dbReachable = await isDatabaseReachable();

async function seedRankedAndExcluded() {
  // One eligible provider (offers the service, always available)...
  const eligible = await registerProvider();
  const { serviceId } = await seedProviderService(eligible.providerProfileId);
  await seedWeeklyHours(eligible.providerProfileId, allWeekAlwaysOpen());

  // ...and one excluded provider who DOES offer the service (runMatching's own candidate query
  // only considers providers with a provider_services row for this service — E1 is therefore
  // already satisfied for every candidate it ever sees, per spec 017 §3's own note) but has no
  // weekly hours configured at all, so E3 excludes them with reason 'unavailable'.
  const excludedProvider = await registerProvider();
  await getDb().insert(providerServices).values({ providerProfileId: excludedProvider.providerProfileId, serviceId, durationMinutes: 60 });

  const customer = await seedCustomerWithAddress();
  const request = await seedSubmittedRequest(customer.userId, serviceId, customer.addressId);
  await runMatching(request.id);

  return { requestId: request.id, eligibleProviderId: eligible.providerProfileId, excludedProviderId: excludedProvider.providerProfileId };
}

describe.skipIf(!dbReachable)('GET /requests/{id}/matches — admin explainability (spec 017 AC-6, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('an operations_admin sees the ranked pool with score breakdown, and the excluded provider with its reason', async () => {
    const { requestId, eligibleProviderId } = await seedRankedAndExcluded();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'read', 'low');

    const res = await GET_MATCHES(sessionGet(`http://localhost/api/v1/requests/${requestId}/matches`, admin));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.eligiblePool).toHaveLength(1);
    expect(data.eligiblePool[0].providerProfileId).toBe(eligibleProviderId);
    expect(data.eligiblePool[0].scoreBreakdown).toBeDefined();
    expect(data.eligiblePool[0].scoreBreakdown.serviceMatch.available).toBe(true);

    expect(data.excluded).toHaveLength(1);
    expect(data.excluded[0].reason).toBe('unavailable');
    expect(data.notifiedProviderProfileIds).toContain(eligibleProviderId);
  });

  it('a super_admin (seeded by this spec\'s own migration) can also read explainability', async () => {
    const { requestId } = await seedRankedAndExcluded();
    const admin = await registerAdmin();
    await grantRole(admin, 'super_admin');
    // Relies on this spec's migration having seeded `matching.config`/`read` for super_admin —
    // no test-local seedPermission call, proving the production migration seed actually works.
    const res = await GET_MATCHES(sessionGet(`http://localhost/api/v1/requests/${requestId}/matches`, admin));
    expect(res.status).toBe(200);
  });

  it('an admin without the matching.config permission is 403 FORBIDDEN', async () => {
    const { requestId } = await seedRankedAndExcluded();
    const admin = await registerAdmin();
    const res = await GET_MATCHES(sessionGet(`http://localhost/api/v1/requests/${requestId}/matches`, admin));
    expect(res.status).toBe(403);
  });

  it('a non-admin (regular session) is 403', async () => {
    const { requestId } = await seedRankedAndExcluded();
    const customer = await registerCustomer();
    const res = await GET_MATCHES(sessionGet(`http://localhost/api/v1/requests/${requestId}/matches`, customer));
    expect(res.status).toBe(403);
  });

  it('an unknown request id is 404', async () => {
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'read', 'low');
    const res = await GET_MATCHES(
      sessionGet('http://localhost/api/v1/requests/00000000-0000-0000-0000-000000000000/matches', admin),
    );
    expect(res.status).toBe(404);
  });
});
