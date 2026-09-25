import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { getPool } from '@/lib/db';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { PLATFORM_DEFAULT_CANCELLATION_CONFIG } from '@/lib/cancellation/policy-config';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { adminWithRole, isDatabaseReachable, roleHoldsPermission, withSnapshot } from './admin-dashboard-test-support';
import { getMarketplaceConfig } from './config';

const dbReachable = await isDatabaseReachable();

async function insertServiceWithOverride(client: PoolClient): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
    [`Cfg ${suffix}`, `cfg-${suffix}`],
  );
  await client.query('INSERT INTO services (category_id, name, slug, matching_weights) VALUES ($1, $2, $3, $4::jsonb)', [
    rows[0]!.id,
    `Cfg Service ${suffix}`,
    `cfg-service-${suffix}`,
    JSON.stringify({ ...DEFAULT_MATCHING_WEIGHTS, rating: 15, reliability: 5 }),
  ]);
}

async function overrideCount(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM services WHERE matching_weights IS NOT NULL');
  return rows[0]!.n;
}

describe.skipIf(!dbReachable)('spec 037 Marketplace configuration (AC-3, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('operations admin sees the real configuration: the default weights and the live override count', async () => {
    const operations = await adminWithRole('operations_admin');
    await withSnapshot(async (db, client) => {
      const before = await getMarketplaceConfig(operations.userId, { db });
      expect(before.matching).toEqual({
        platformDefaultWeights: DEFAULT_MATCHING_WEIGHTS,
        serviceOverrideCount: await overrideCount(client),
        linkTo: '/admin/marketplace/matching',
      });
      await insertServiceWithOverride(client);
      const after = await getMarketplaceConfig(operations.userId, { db });
      expect(after.matching!.serviceOverrideCount).toBe(before.matching!.serviceOverrideCount + 1);
    });
  });

  it('shows the active platform cancellation policy — and null when none is active — with no editor link', async () => {
    const operations = await adminWithRole('operations_admin');
    await withSnapshot(async (db, client) => {
      await client.query(
        "UPDATE policies SET is_active = false WHERE type = 'cancellation' AND scope = 'platform' AND is_active",
      );
      expect((await getMarketplaceConfig(operations.userId, { db })).cancellation).toEqual({
        activePlatformPolicy: null,
        linkTo: null,
      });

      const { rows: policy } = await client.query<{ id: string }>(
        "INSERT INTO policies (type, scope, scope_id, is_active) VALUES ('cancellation', 'platform', NULL, true) RETURNING id",
      );
      const { rows: version } = await client.query<{ effective_from: Date }>(
        `INSERT INTO policy_versions (policy_id, config, effective_from, effective_to, created_by_admin_id, note)
         VALUES ($1, $2::jsonb, clock_timestamp(), NULL, $3, 'fixture') RETURNING effective_from`,
        [policy[0]!.id, JSON.stringify(PLATFORM_DEFAULT_CANCELLATION_CONFIG), operations.adminProfileId],
      );
      expect((await getMarketplaceConfig(operations.userId, { db })).cancellation).toEqual({
        activePlatformPolicy: {
          policyId: policy[0]!.id,
          effectiveFrom: new Date(version[0]!.effective_from).toISOString(),
          config: PLATFORM_DEFAULT_CANCELLATION_CONFIG,
        },
        linkTo: null,
      });
    });
  });

  it('super_admin sees both sections; a role holding neither read permission is refused with 403 FORBIDDEN', async () => {
    const superAdmin = await adminWithRole('super_admin');
    const both = await getMarketplaceConfig(superAdmin.userId);
    expect(Object.keys(both).sort()).toEqual(['cancellation', 'generatedAt', 'matching']);

    const refused = ['content_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'analytics_admin'] as AdminRole[];
    for (const role of refused) {
      // None of these five is granted either read permission by any migration; skip one only if
      // another spec's test has since granted it in the shared database.
      if ((await roleHoldsPermission(role, 'matching.config', 'read')) || (await roleHoldsPermission(role, 'cancellation_policy', 'read'))) continue;
      const admin = await adminWithRole(role);
      const refusal = await getMarketplaceConfig(admin.userId).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal, role).toBeInstanceOf(ApiRouteError);
      expect((refusal as ApiRouteError).code).toBe('FORBIDDEN');
    }
  }, 60_000);

  it('nothing is written: reading the configuration changes no service or policy row', async () => {
    const operations = await adminWithRole('operations_admin');
    await withSnapshot(async (db, client) => {
      const snapshot = async () =>
        (
          await client.query<{ s: string }>(
            `SELECT (SELECT coalesce(sum(version), 0) FROM services)::text || ':' ||
                    (SELECT coalesce(sum(version), 0) FROM policies)::text || ':' ||
                    (SELECT count(*) FROM policy_versions)::text AS s`,
          )
        ).rows[0]!.s;
      const before = await snapshot();
      await getMarketplaceConfig(operations.userId, { db });
      expect(await snapshot()).toBe(before);
    });
  });
});
