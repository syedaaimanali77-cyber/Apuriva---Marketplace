import { beforeAll, describe, expect, it } from 'vitest';
import { adminWithRole } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { isFeatureEnabled } from './resolve';
import { listFeatureFlags, toggleFeatureFlag } from './admin';
import { isDatabaseReachable, restoreStoredFlags, storedFlag, useFlagEnvironment } from './feature-flags-test-support';

/**
 * Spec 041 AC-1 — a business admin toggles a business flag for the running environment and the very
 * next read returns the new value: no deploy, no restart. Worker runs as `staging` with
 * `home-personalization-v1` (no other spec 041 file changes that pair).
 */
const dbReachable = await isDatabaseReachable();
const KEY = 'home-personalization-v1';

describe.skipIf(!dbReachable)('toggling a business flag (spec 041 AC-1)', { timeout: 120_000 }, () => {
  useFlagEnvironment('staging');
  restoreStoredFlags([[KEY, 'staging']]);
  let content: TestAdmin;
  let operations: TestAdmin;

  beforeAll(async () => {
    content = await adminWithRole('content_admin');
    operations = await adminWithRole('operations_admin');
  }, 120_000);

  it('takes effect on the next read, for Content/Marketplace and Operations admins alike', async () => {
    const start = await storedFlag(KEY, 'staging');
    const off = await toggleFeatureFlag(content.userId, KEY, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version, reason: 'AC-1 content' });
    expect(off).toMatchObject({ key: KEY, environment: 'staging', enabled: !start.enabled, effective: !start.enabled, overriddenBy: null, version: start.version + 1 });
    expect(await isFeatureEnabled(KEY)).toBe(!start.enabled);

    const back = await toggleFeatureFlag(operations.userId, KEY, { environment: 'staging', enabled: start.enabled, expectedVersion: off.version, reason: 'AC-1 operations' });
    expect(back.enabled).toBe(start.enabled);
    expect(await isFeatureEnabled(KEY)).toBe(start.enabled);
  });

  it('records who changed it', async () => {
    const start = await storedFlag(KEY, 'staging');
    await toggleFeatureFlag(content.userId, KEY, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version, reason: 'who' });
    const { getDb } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const { rows } = (await getDb().execute(sql`
      SELECT v.updated_by_admin_id FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id
       WHERE f.key = ${KEY} AND v.environment = 'staging'`)) as unknown as { rows: { updated_by_admin_id: string }[] };
    expect(rows[0]!.updated_by_admin_id).toBe(content.adminProfileId);
  });

  it('setting the value it already has is a no-op: 200 with the current DTO, no version bump', async () => {
    const start = await storedFlag(KEY, 'staging');
    const same = await toggleFeatureFlag(content.userId, KEY, { environment: 'staging', enabled: start.enabled, expectedVersion: start.version, reason: 'no-op' });
    expect(same).toMatchObject({ enabled: start.enabled, version: start.version });
    expect(await storedFlag(KEY, 'staging')).toEqual(start);
  });

  it('a stale expectedVersion is 409 CONFLICT and changes nothing', async () => {
    const start = await storedFlag(KEY, 'staging');
    await expect(
      toggleFeatureFlag(content.userId, KEY, { environment: 'staging', enabled: !start.enabled, expectedVersion: start.version - 1 || 999, reason: 'stale' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409, details: { currentVersion: start.version } });
    expect(await storedFlag(KEY, 'staging')).toEqual(start);
  });

  it('the list shows the new value for the running environment', async () => {
    const start = await storedFlag(KEY, 'staging');
    const listed = (await listFeatureFlags(content.userId)).find((f) => f.key === KEY)!;
    expect(listed).toMatchObject({ environment: 'staging', enabled: start.enabled, version: start.version });
    expect(new Date(listed.updatedAt).getTime()).toBeGreaterThan(0);
  });
});
