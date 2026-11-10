/**
 * Spec 041 test support. Test-only; never imported by production code.
 *
 * Flag values are GLOBAL in the shared `*_test` database, and other specs' tests read the
 * `development` rows (the default when APP_ENV is unset). So every spec 041 test that changes a
 * stored value:
 *   - runs its worker under `APP_ENV=staging` or `production` (`useFlagEnvironment`), never touching
 *     the `development` rows other files read;
 *   - uses flags no other spec 041 file changes in that environment;
 *   - clears the flag's env override var for its own worker (the developer's `.env` may set it);
 *   - restores every value it changed (`restoreStoredFlags`).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { FlagEnvironment } from '@/lib/types/feature-flags';
import { FEATURE_FLAG_REGISTRY, type FeatureFlagKey } from './registry';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** Runs the calling file's worker under `environment`, and clears every flag override var. */
export function useFlagEnvironment(environment: FlagEnvironment): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    saved.APP_ENV = process.env.APP_ENV;
    process.env.APP_ENV = environment;
    for (const flag of FEATURE_FLAG_REGISTRY) {
      if (!flag.overrideVar) continue;
      saved[flag.overrideVar] = process.env[flag.overrideVar];
      delete process.env[flag.overrideVar];
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

export async function storedFlag(key: FeatureFlagKey, environment: FlagEnvironment): Promise<{ enabled: boolean; version: number }> {
  const [row] = await queryRows<{ enabled: boolean; version: number }>(
    getDb(),
    sql`SELECT v.enabled, v.version FROM feature_flag_environment_values v JOIN feature_flags f ON f.id = v.feature_flag_id
         WHERE f.key = ${key} AND v.environment = ${environment}`,
  );
  if (!row) throw new Error(`No stored value for ${key}/${environment}`);
  return row;
}

/** Sets a stored value directly (test fixture), as an admin toggle would, bumping `version`. */
export async function setStoredFlag(key: FeatureFlagKey, environment: FlagEnvironment, enabled: boolean): Promise<void> {
  await getDb().execute(sql`
    UPDATE feature_flag_environment_values v SET enabled = ${enabled}, version = v.version + 1, updated_at = clock_timestamp()
      FROM feature_flags f
     WHERE f.id = v.feature_flag_id AND f.key = ${key} AND v.environment = ${environment}
  `);
}

/** Snapshots the given (flag, environment) values before the file and restores them after it. */
export function restoreStoredFlags(entries: [FeatureFlagKey, FlagEnvironment][]): void {
  const snapshot: { key: FeatureFlagKey; environment: FlagEnvironment; enabled: boolean }[] = [];
  beforeAll(async () => {
    for (const [key, environment] of entries) snapshot.push({ key, environment, enabled: (await storedFlag(key, environment)).enabled });
  });
  afterAll(async () => {
    for (const { key, environment, enabled } of snapshot) await setStoredFlag(key, environment, enabled);
  });
}
