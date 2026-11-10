/**
 * Spec 041 §3.4 / §3.7 (AC-1, AC-4, AC-6) — reading a flag.
 *
 * Resolution order:
 *   1. the flag's env override var, when set to EXACTLY 'true' or 'false' (deploy-level control, D-3);
 *   2. the stored value for (key, currentFlagEnvironment());
 *   3. the registry default for this environment, if the row is missing (logged).
 *
 * NO process-local cache (D-7): every call is one indexed query, so a switched-off kill switch
 * stops the very next request on any instance. A failed read THROWS — it is never replaced by the
 * default, so a switched-off kill switch cannot come back on because the database hiccupped.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { currentFlagEnvironment } from './environment';
import { envOverride, FEATURE_FLAG_REGISTRY, flagDefinition, type ClientFlagKey, type FeatureFlagKey } from './registry';

function logMissing(key: string, environment: string): void {
  console.warn(JSON.stringify({ event: 'feature_flags.value_missing', key, environment, at: new Date().toISOString() }));
}

/** Whether `key` is on for this request. See the module comment for the resolution order. */
export async function isFeatureEnabled(key: FeatureFlagKey, db: Executor = getDb()): Promise<boolean> {
  const override = envOverride(key);
  if (override !== null) return override;

  const environment = currentFlagEnvironment();
  const [row] = await queryRows<{ enabled: boolean }>(
    db,
    sql`SELECT v.enabled
          FROM feature_flag_environment_values v
          JOIN feature_flags f ON f.id = v.feature_flag_id
         WHERE f.key = ${key} AND v.environment = ${environment}`,
  );
  if (row) return row.enabled;
  logMissing(key, environment);
  return flagDefinition(key).defaults[environment];
}

/** Every client-readable flag (§3.6 F3), resolved in one query. Never a developer flag. */
export async function resolveClientFlags(db: Executor = getDb()): Promise<Record<ClientFlagKey, boolean>> {
  const environment = currentFlagEnvironment();
  const clientFlags = FEATURE_FLAG_REGISTRY.filter((f) => f.clientReadable);
  const rows = await queryRows<{ key: string; enabled: boolean }>(
    db,
    sql`SELECT f.key, v.enabled
          FROM feature_flags f
          JOIN feature_flag_environment_values v ON v.feature_flag_id = f.id AND v.environment = ${environment}
         WHERE f.client_readable AND f.controlled_by = 'business'`,
  );
  const stored = new Map(rows.map((r) => [r.key, r.enabled]));
  const result = {} as Record<ClientFlagKey, boolean>;
  for (const flag of clientFlags) {
    const override = envOverride(flag.key);
    let value = override ?? stored.get(flag.key);
    if (value === undefined) {
      logMissing(flag.key, environment);
      value = flag.defaults[environment];
    }
    result[flag.key] = value;
  }
  return result;
}
