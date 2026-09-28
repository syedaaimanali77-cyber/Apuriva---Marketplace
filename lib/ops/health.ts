/**
 * Spec 046 §3.7 (AC-8) — the readiness/diagnostic report behind `GET /api/v1/health/detailed`.
 * Liveness stays spec 001's `GET /api/v1/health`, which is deliberately NOT changed to fail on the
 * database (its own test, and the Docker healthcheck, depend on it answering 200 while the process
 * serves).
 *
 * Every probe is injectable so tests can simulate an outage deterministically. Nothing here makes a
 * network call to an external provider: adapters are judged from their configuration only.
 *
 * Rules (status is the worst row: any `down` → down, any `degraded` → degraded, else healthy):
 *   database          SELECT 1 within 2 s                      down when it fails or times out
 *   migrations        journal entries vs applied migrations     degraded when the database is behind
 *   cron:<job>        cron_job_heartbeats                        degraded: never_ran / stale / 3_consecutive_failures
 *   kill-switch:<key> isFeatureEnabled (spec 041)                degraded when the switch is OFF
 *   adapter:<port>    configured adapter name                   degraded: sandbox_in_production / not_configured
 * When the database is down, the rows that need it are `down` with `database_unavailable` —
 * never guessed as healthy.
 */
import journal from '@/drizzle/meta/_journal.json';
import packageJson from '@/package.json';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { readCronHeartbeats, type CronHeartbeatRow } from '@/lib/cron/heartbeats';
import { CRON_SCHEDULES, type CronSchedule } from '@/lib/cron/schedules';
import { currentFlagEnvironment, FEATURE_FLAG_REGISTRY, isFeatureEnabled, type FeatureFlagKey } from '@/lib/feature-flags';
import type { DetailedHealthDto, HealthDependencyDto, HealthStatus } from '@/lib/types/ops';

export const DATABASE_TIMEOUT_MS = 2000;
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/** Each port, the env var that selects its adapter, that adapter's default, and which names are sandboxes. */
export const ADAPTER_PORTS: ReadonlyArray<{ port: string; envVar: string; defaultName: string | null; sandboxNames: readonly string[] }> = [
  { port: 'payments', envVar: 'PAYMENT_PROVIDER', defaultName: null, sandboxNames: ['sandbox'] },
  { port: 'payouts', envVar: 'PAYOUT_PROVIDER', defaultName: null, sandboxNames: ['sandbox'] },
  { port: 'notifications', envVar: 'NOTIFICATION_CHANNEL_PROVIDER', defaultName: null, sandboxNames: ['sandbox'] },
  { port: 'files', envVar: 'FILE_STORAGE_PROVIDER', defaultName: 'local', sandboxNames: ['local'] },
  { port: 'file-scanner', envVar: 'FILE_SCANNER', defaultName: 'sandbox', sandboxNames: ['sandbox'] },
  { port: 'ai', envVar: 'AI_PROVIDER', defaultName: 'sandbox', sandboxNames: ['sandbox'] },
];

export interface HealthProbes {
  now: () => Date;
  environment: () => DetailedHealthDto['environment'];
  env: (name: string) => string | undefined;
  pingDatabase: () => Promise<void>;
  appliedMigrationCount: () => Promise<number>;
  heartbeats: () => Promise<CronHeartbeatRow[]>;
  killSwitchEnabled: (key: FeatureFlagKey) => Promise<boolean>;
}

export const defaultProbes: HealthProbes = {
  now: () => new Date(),
  environment: () => currentFlagEnvironment(),
  env: (name) => process.env[name],
  pingDatabase: async () => {
    await getPool().query('SELECT 1');
  },
  appliedMigrationCount: async () => {
    const result = await getDb().execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    return Number((result.rows[0] as { n: number }).n);
  },
  heartbeats: () => readCronHeartbeats(),
  killSwitchEnabled: (key) => isFeatureEnabled(key),
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function cronDependency(schedule: CronSchedule, row: CronHeartbeatRow | undefined, now: Date): HealthDependencyDto {
  const name = `cron:${schedule.job}`;
  if (!row) return { name, status: 'degraded', detail: 'never_ran' };
  if (row.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return { name, status: 'degraded', detail: `${CONSECUTIVE_FAILURE_THRESHOLD}_consecutive_failures` };
  }
  if (!row.lastSucceededAt || now.getTime() - row.lastSucceededAt.getTime() > schedule.staleAfterMs) {
    return { name, status: 'degraded', detail: 'stale' };
  }
  return { name, status: 'up' };
}

export function adapterDependency(
  entry: (typeof ADAPTER_PORTS)[number],
  configured: string | undefined,
  environment: DetailedHealthDto['environment'],
): HealthDependencyDto {
  const name = `adapter:${entry.port}`;
  const adapter = (configured ?? '').trim() || entry.defaultName;
  if (!adapter) return environment === 'production' ? { name, status: 'degraded', detail: 'not_configured' } : { name, status: 'up' };
  if (environment === 'production' && entry.sandboxNames.includes(adapter)) {
    return { name, status: 'degraded', detail: 'sandbox_in_production' };
  }
  return { name, status: 'up' };
}

export function overallStatus(dependencies: readonly HealthDependencyDto[]): HealthStatus {
  if (dependencies.some((d) => d.status === 'down')) return 'down';
  if (dependencies.some((d) => d.status === 'degraded')) return 'degraded';
  return 'healthy';
}

const KILL_SWITCH_KEYS = FEATURE_FLAG_REGISTRY.filter((f) => f.isKillSwitch).map((f) => f.key as FeatureFlagKey);

export async function buildDetailedHealth(probes: HealthProbes = defaultProbes): Promise<DetailedHealthDto> {
  const environment = probes.environment();
  const dependencies: HealthDependencyDto[] = [];

  const startedAt = Date.now();
  let databaseUp = true;
  try {
    await withTimeout(probes.pingDatabase(), DATABASE_TIMEOUT_MS);
    dependencies.push({ name: 'database', status: 'up', latencyMs: Date.now() - startedAt });
  } catch (err) {
    databaseUp = false;
    dependencies.push({ name: 'database', status: 'down', detail: err instanceof Error && err.message === 'timeout' ? 'timeout' : 'unreachable' });
  }

  const unavailable = (name: string): HealthDependencyDto => ({ name, status: 'down', detail: 'database_unavailable' });

  if (!databaseUp) {
    dependencies.push(unavailable('migrations'));
    for (const schedule of CRON_SCHEDULES) dependencies.push(unavailable(`cron:${schedule.job}`));
    for (const key of KILL_SWITCH_KEYS) dependencies.push(unavailable(`kill-switch:${key}`));
  } else {
    try {
      const applied = await probes.appliedMigrationCount();
      dependencies.push(
        applied >= journal.entries.length ? { name: 'migrations', status: 'up' } : { name: 'migrations', status: 'degraded', detail: 'migrations_behind' },
      );
    } catch {
      dependencies.push({ name: 'migrations', status: 'degraded', detail: 'migrations_unknown' });
    }

    let rows: CronHeartbeatRow[] | null = null;
    try {
      rows = await probes.heartbeats();
    } catch {
      rows = null;
    }
    const now = probes.now();
    for (const schedule of CRON_SCHEDULES) {
      dependencies.push(
        rows === null
          ? { name: `cron:${schedule.job}`, status: 'degraded', detail: 'heartbeats_unreadable' }
          : cronDependency(schedule, rows.find((r) => r.job === schedule.job), now),
      );
    }

    for (const key of KILL_SWITCH_KEYS) {
      const name = `kill-switch:${key}`;
      try {
        dependencies.push((await probes.killSwitchEnabled(key)) ? { name, status: 'up' } : { name, status: 'degraded', detail: 'kill_switch_off' });
      } catch {
        dependencies.push({ name, status: 'degraded', detail: 'flag_unreadable' });
      }
    }
  }

  for (const entry of ADAPTER_PORTS) dependencies.push(adapterDependency(entry, probes.env(entry.envVar), environment));

  return {
    status: overallStatus(dependencies),
    environment,
    version: packageJson.version,
    commit: probes.env('VERCEL_GIT_COMMIT_SHA')?.trim() || null,
    checkedAt: probes.now().toISOString(),
    dependencies,
  };
}
