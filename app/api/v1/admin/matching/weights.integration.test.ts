import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { services } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { registerAdmin, registerAdminWithPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { PATCH as PATCH_WEIGHTS } from '../services/[id]/matching-weights/route';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { authenticatedRequest, isDatabaseReachable, registerProvider, seedProviderService } from '@/lib/matching/matching-test-support';
import type { TestSession } from '@/lib/matching/matching-test-support';

const dbReachable = await isDatabaseReachable();

async function seedService(): Promise<{ serviceId: string }> {
  const provider = await registerProvider();
  return seedProviderService(provider.providerProfileId);
}

function patchWeights(serviceId: string, admin: TestSession, body: unknown): Request {
  return authenticatedRequest(`http://localhost/api/v1/admin/services/${serviceId}/matching-weights`, admin.sessionId, admin.csrfToken, {
    method: 'PATCH',
    body,
  });
}

describe.skipIf(!dbReachable)('PATCH /admin/services/{id}/matching-weights (spec 017 AC-2, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('an operations_admin can set a valid per-service weight override and pool size', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');
    const customWeights = { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 };

    const res = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { weights: customWeights, poolSize: 25 }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.effectiveWeights).toEqual(customWeights);
    expect(data.effectivePoolSize).toBe(25);

    const [row] = await getDb()
      .select({ matchingWeights: services.matchingWeights, matchingPoolSize: services.matchingPoolSize })
      .from(services)
      .where(eq(services.id, serviceId));
    expect(row!.matchingWeights).toEqual(customWeights);
    expect(row!.matchingPoolSize).toBe(25);
  });

  it('weights that do not sum to 100 are rejected — 422 INVALID_MATCHING_WEIGHTS', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    const res = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { weights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 999 } }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_MATCHING_WEIGHTS');
  });

  it('a pool size outside 1..50 is rejected', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    const res = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { poolSize: 51 }));
    expect(res.status).toBe(422);
  });

  it('null clears the override, falling back to the platform defaults', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    await PATCH_WEIGHTS(patchWeights(serviceId, admin, { weights: { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 } }));
    const cleared = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { weights: null }));
    const { data } = await cleared.json();
    expect(data.weights).toBeNull();
    expect(data.effectiveWeights).toEqual(DEFAULT_MATCHING_WEIGHTS);
  });

  it('a stale expectedVersion is 409 CONFLICT (spec 003 AC-6 optimistic concurrency)', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');

    const res = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { poolSize: 20, expectedVersion: 999 }));
    expect(res.status).toBe(409);
  });

  it('an admin lacking the matching.config/configure permission is 403', async () => {
    const { serviceId } = await seedService();
    const admin = await registerAdmin();
    const res = await PATCH_WEIGHTS(patchWeights(serviceId, admin, { poolSize: 20 }));
    expect(res.status).toBe(403);
  });

  it('an unknown service id is 404', async () => {
    const admin = await registerAdminWithPermission('operations_admin', 'matching.config', 'configure', 'medium');
    const res = await PATCH_WEIGHTS(
      patchWeights('00000000-0000-0000-0000-000000000000', admin, { poolSize: 20 }),
    );
    expect(res.status).toBe(404);
  });
});
