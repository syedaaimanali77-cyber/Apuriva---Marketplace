/**
 * Spec 042 test support. Test-only; never imported by production code.
 *
 * `urdu-locale` values are GLOBAL in the shared `*_test` database, and several spec 042 files need it
 * both on and off. Following the spec 041 rules (`lib/feature-flags/feature-flags-test-support.ts`), every
 * file that changes it:
 *   - runs its worker under `APP_ENV=staging` (`useFlagEnvironment`), never touching the `development`
 *     rows other specs' tests read;
 *   - holds one Postgres advisory lock for the whole file (`useUrduLocaleFlag`), so two spec 042 files
 *     never flip the same stored value underneath each other when Vitest runs them in parallel;
 *   - restores the value it found (`restoreStoredFlags`).
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { getPool } from '@/lib/db';
import { restoreStoredFlags, setStoredFlag, useFlagEnvironment } from '@/lib/feature-flags/feature-flags-test-support';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** An arbitrary constant key, private to spec 042's flag-toggling test files. */
const URDU_LOCALE_TEST_LOCK = 42_042_042;

/**
 * Registers the file-level hooks. Call at the top of a `describe` (or module) body. The returned
 * `setUrduLocale` changes the stored `staging` value — the one this file's worker reads.
 */
export function useUrduLocaleFlag(): { setUrduLocale: (enabled: boolean) => Promise<void> } {
  let lockClient: PoolClient | null = null;
  useFlagEnvironment('staging');
  beforeAll(async () => {
    lockClient = await getPool().connect();
    await lockClient.query('SELECT pg_advisory_lock($1)', [URDU_LOCALE_TEST_LOCK]);
  }, 120_000);
  // Registered after the lock, so the snapshot is taken while holding it; vitest runs `afterAll` hooks in
  // reverse, so the value is restored before the lock is released below.
  restoreStoredFlags([['urdu-locale', 'staging']]);
  afterAll(async () => {
    if (!lockClient) return;
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [URDU_LOCALE_TEST_LOCK]);
    } finally {
      lockClient.release();
      lockClient = null;
    }
  });
  return { setUrduLocale: (enabled) => setStoredFlag('urdu-locale', 'staging', enabled) };
}
