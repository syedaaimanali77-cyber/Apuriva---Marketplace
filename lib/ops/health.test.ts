import { afterEach, describe, expect, it, vi } from 'vitest';
import journal from '@/drizzle/meta/_journal.json';
import type { CronHeartbeatRow } from '@/lib/cron/heartbeats';
import { CRON_SCHEDULES, cronSchedule } from '@/lib/cron/schedules';
import type { HealthProbes } from './health';
import { adapterDependency, ADAPTER_PORTS, buildDetailedHealth, cronDependency, DATABASE_TIMEOUT_MS, overallStatus } from './health';

const NOW = new Date('2026-09-28T12:00:00Z');

function heartbeat(job: string, overrides: Partial<CronHeartbeatRow> = {}): CronHeartbeatRow {
  return {
    id: 'x',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    job,
    lastStartedAt: NOW,
    lastSucceededAt: NOW,
    lastFailedAt: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Everything healthy: every job succeeded just now, migrations current, kill switches on, real adapters. */
function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  const env: Record<string, string> = {
    PAYMENT_PROVIDER: 'vendor',
    PAYOUT_PROVIDER: 'vendor',
    NOTIFICATION_CHANNEL_PROVIDER: 'vendor',
    FILE_STORAGE_PROVIDER: 'object-store',
    FILE_SCANNER: 'scanner',
    AI_PROVIDER: 'openai',
    VERCEL_GIT_COMMIT_SHA: 'abc123',
  };
  return {
    now: () => NOW,
    environment: () => 'production',
    env: (name) => env[name],
    pingDatabase: async () => {},
    appliedMigrationCount: async () => journal.entries.length,
    heartbeats: async () => CRON_SCHEDULES.map((s) => heartbeat(s.job)),
    killSwitchEnabled: async () => true,
    ...overrides,
  };
}

const dep = (health: Awaited<ReturnType<typeof buildDetailedHealth>>, name: string) => health.dependencies.find((d) => d.name === name);

afterEach(() => {
  vi.useRealTimers();
});

describe('buildDetailedHealth (spec 046 §3.7, AC-8)', () => {
  it('reports healthy with every dependency up, version, commit and checkedAt', async () => {
    const health = await buildDetailedHealth(probes());
    expect(health.status).toBe('healthy');
    expect(health.environment).toBe('production');
    expect(health.commit).toBe('abc123');
    expect(health.checkedAt).toBe(NOW.toISOString());
    expect(typeof health.version).toBe('string');
    expect(health.dependencies.every((d) => d.status === 'up')).toBe(true);
    expect(dep(health, 'database')!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.dependencies.map((d) => d.name)).toEqual(
      expect.arrayContaining(['database', 'migrations', 'kill-switch:ai-assistant', ...CRON_SCHEDULES.map((s) => `cron:${s.job}`), ...ADAPTER_PORTS.map((a) => `adapter:${a.port}`)]),
    );
  });

  it('is DOWN when the database is unreachable, and never guesses the rows that need it', async () => {
    const health = await buildDetailedHealth(
      probes({
        pingDatabase: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        },
      }),
    );
    expect(health.status).toBe('down');
    expect(dep(health, 'database')).toEqual({ name: 'database', status: 'down', detail: 'unreachable' });
    for (const name of ['migrations', 'kill-switch:ai-assistant', `cron:${CRON_SCHEDULES[0]!.job}`]) {
      expect(dep(health, name)).toEqual({ name, status: 'down', detail: 'database_unavailable' });
    }
    expect(JSON.stringify(health)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it('is DOWN with detail "timeout" when the database does not answer within 2 s', async () => {
    vi.useFakeTimers();
    const pending = buildDetailedHealth(probes({ pingDatabase: () => new Promise<void>(() => {}) }));
    await vi.advanceTimersByTimeAsync(DATABASE_TIMEOUT_MS + 1);
    const health = await pending;
    expect(dep(health, 'database')).toEqual({ name: 'database', status: 'down', detail: 'timeout' });
  });

  it('is DEGRADED when migrations are behind or unreadable', async () => {
    expect(dep(await buildDetailedHealth(probes({ appliedMigrationCount: async () => journal.entries.length - 1 })), 'migrations')).toEqual({
      name: 'migrations',
      status: 'degraded',
      detail: 'migrations_behind',
    });
    const unknown = await buildDetailedHealth(
      probes({
        appliedMigrationCount: async () => {
          throw new Error('no table');
        },
      }),
    );
    expect(dep(unknown, 'migrations')!.detail).toBe('migrations_unknown');
    expect(unknown.status).toBe('degraded');
  });

  it('is DEGRADED when a kill switch is off, or its flag cannot be read', async () => {
    const off = await buildDetailedHealth(probes({ killSwitchEnabled: async () => false }));
    expect(off.status).toBe('degraded');
    expect(dep(off, 'kill-switch:ai-assistant')).toEqual({ name: 'kill-switch:ai-assistant', status: 'degraded', detail: 'kill_switch_off' });
    const unreadable = await buildDetailedHealth(
      probes({
        killSwitchEnabled: async () => {
          throw new Error('x');
        },
      }),
    );
    expect(dep(unreadable, 'kill-switch:ai-assistant')!.detail).toBe('flag_unreadable');
  });

  it('marks every sweep degraded when heartbeats cannot be read', async () => {
    const health = await buildDetailedHealth(
      probes({
        heartbeats: async () => {
          throw new Error('x');
        },
      }),
    );
    expect(health.dependencies.filter((d) => d.name.startsWith('cron:')).every((d) => d.detail === 'heartbeats_unreadable')).toBe(true);
  });

  it('reports a sandbox adapter in production, and a missing commit as null', async () => {
    const health = await buildDetailedHealth(
      probes({ env: (name) => (name === 'PAYMENT_PROVIDER' ? 'sandbox' : name === 'VERCEL_GIT_COMMIT_SHA' ? '  ' : 'vendor') }),
    );
    expect(dep(health, 'adapter:payments')).toEqual({ name: 'adapter:payments', status: 'degraded', detail: 'sandbox_in_production' });
    expect(health.commit).toBeNull();
  });
});

describe('cronDependency (AC-5 staleness rules)', () => {
  const schedule = cronSchedule('offer-expiry-sweep')!; // every minute → stale after 10 minutes

  it.each([
    ['never ran', undefined, 'never_ran'],
    ['never succeeded', heartbeat('offer-expiry-sweep', { lastSucceededAt: null }), 'stale'],
    ['succeeded 11 minutes ago', heartbeat('offer-expiry-sweep', { lastSucceededAt: new Date(NOW.getTime() - 11 * 60_000) }), 'stale'],
    ['3 consecutive failures', heartbeat('offer-expiry-sweep', { consecutiveFailures: 3 }), '3_consecutive_failures'],
  ])('%s → degraded (%s)', (_label, row, detail) => {
    expect(cronDependency(schedule, row, NOW)).toEqual({ name: 'cron:offer-expiry-sweep', status: 'degraded', detail });
  });

  it('is up after a recent success, even with 2 failures since', () => {
    const row = heartbeat('offer-expiry-sweep', { lastSucceededAt: new Date(NOW.getTime() - 9 * 60_000), consecutiveFailures: 2 });
    expect(cronDependency(schedule, row, NOW)).toEqual({ name: 'cron:offer-expiry-sweep', status: 'up' });
  });
});

describe('adapterDependency', () => {
  const payments = ADAPTER_PORTS.find((a) => a.port === 'payments')!;
  const storage = ADAPTER_PORTS.find((a) => a.port === 'files')!;

  it('is up outside production for a sandbox or an unset adapter', () => {
    expect(adapterDependency(payments, 'sandbox', 'staging').status).toBe('up');
    expect(adapterDependency(payments, undefined, 'development').status).toBe('up');
  });

  it('flags an unconfigured adapter and a defaulted sandbox in production', () => {
    expect(adapterDependency(payments, '  ', 'production')).toEqual({ name: 'adapter:payments', status: 'degraded', detail: 'not_configured' });
    expect(adapterDependency(storage, undefined, 'production')).toEqual({ name: 'adapter:files', status: 'degraded', detail: 'sandbox_in_production' });
  });
});

describe('overallStatus', () => {
  it('is the worst dependency status', () => {
    expect(overallStatus([{ name: 'a', status: 'up' }])).toBe('healthy');
    expect(overallStatus([{ name: 'a', status: 'up' }, { name: 'b', status: 'degraded' }])).toBe('degraded');
    expect(overallStatus([{ name: 'a', status: 'degraded' }, { name: 'b', status: 'down' }])).toBe('down');
  });
});
