import { beforeAll, describe, expect, it } from 'vitest';
import { adminWithRole } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { isFeatureEnabled, resolveClientFlags } from './resolve';
import { listFeatureFlags, toggleFeatureFlag } from './admin';
import { isDatabaseReachable, restoreStoredFlags, setStoredFlag, storedFlag, useFlagEnvironment } from './feature-flags-test-support';

/**
 * Spec 041 AC-6 / §3.2 — values are keyed per environment and a deployment reads and writes only its
 * own. Uses `onboarding-intro-v1` in `staging` and `production` only (never the `development` row
 * other specs' tests read).
 */
const dbReachable = await isDatabaseReachable();
const KEY = 'onboarding-intro-v1';

describe.skipIf(!dbReachable)('environment isolation (spec 041 AC-6)', { timeout: 120_000 }, () => {
  useFlagEnvironment('staging');
  restoreStoredFlags([
    [KEY, 'staging'],
    [KEY, 'production'],
  ]);
  let content: Awaited<ReturnType<typeof adminWithRole>>;

  beforeAll(async () => {
    content = await adminWithRole('content_admin');
  }, 120_000);

  it('each environment reads only its own stored value', async () => {
    await setStoredFlag(KEY, 'staging', false);
    await setStoredFlag(KEY, 'production', true);
    process.env.APP_ENV = 'staging';
    expect(await isFeatureEnabled(KEY)).toBe(false);
    expect(await resolveClientFlags()).toEqual({ [KEY]: false, 'urdu-locale': false }); // spec 042 X-15: seeded off
    process.env.APP_ENV = 'production';
    expect(await isFeatureEnabled(KEY)).toBe(true);
    expect(await resolveClientFlags()).toEqual({ [KEY]: true, 'urdu-locale': false });
    process.env.APP_ENV = 'staging';
  });

  it('a staging toggle changes exactly one row and never the production value', async () => {
    await setStoredFlag(KEY, 'production', true);
    const production = await storedFlag(KEY, 'production');
    const staging = await storedFlag(KEY, 'staging');
    await toggleFeatureFlag(content.userId, KEY, { environment: 'staging', enabled: !staging.enabled, expectedVersion: staging.version, reason: 'AC-6 staging only' });
    expect((await storedFlag(KEY, 'staging')).enabled).toBe(!staging.enabled);
    expect(await storedFlag(KEY, 'production')).toEqual(production);
  });

  it('a deployment refuses to write another environment: 409 FLAG_ENVIRONMENT_MISMATCH, nothing changes', async () => {
    const production = await storedFlag(KEY, 'production');
    await expect(
      toggleFeatureFlag(content.userId, KEY, { environment: 'production', enabled: !production.enabled, expectedVersion: production.version, reason: 'cross-env' }),
    ).rejects.toMatchObject({ code: 'FLAG_ENVIRONMENT_MISMATCH', status: 409 });
    expect(await storedFlag(KEY, 'production')).toEqual(production);
  });

  it('the admin list shows the running environment only', async () => {
    const listed = await listFeatureFlags(content.userId);
    expect(listed.every((f) => f.environment === 'staging')).toBe(true);
    expect(listed.find((f) => f.key === KEY)!.enabled).toBe((await storedFlag(KEY, 'staging')).enabled);
  });
});
