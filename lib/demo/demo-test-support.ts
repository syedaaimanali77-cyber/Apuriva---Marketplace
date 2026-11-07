/**
 * Spec 045 §6 test support. Every demo integration test runs on the isolated `*_test` database
 * (vitest.config.ts) and never renames or creates a database: a test that needs the `_demo` guard to pass
 * stubs `databaseNameReader` instead.
 */
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { addDays, utcToZoned, zonedDateTimeToUtc } from '@/lib/availability/timezone';
import { queryRows } from '@/lib/offers/db';
import { registerBookingBusyIntervals } from '@/lib/bookings/busy-intervals';
import { databaseNameReader } from './guards';
import { DEMO_TIMEZONE } from './seed/writers';

export { isDatabaseReachable } from '@/lib/offers/offers-test-support';

const ENV_KEYS = ['APP_ENV', 'DEMO_MODE_ENABLED', 'NODE_ENV', 'PAYMENT_PROVIDER'] as const;

/** Puts the process into a passing demo environment (§3.1 conditions 1–3) and returns a restore function. */
export function enterDemoEnvironment(): () => void {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_ENV = 'staging';
  process.env.DEMO_MODE_ENABLED = 'true';
  const spy = vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva_demo');
  // Spec 020's live busy-interval loader, as `lib/bookings` registers it in a server.
  registerBookingBusyIntervals();
  return () => {
    spy.mockRestore();
    for (const key of ENV_KEYS) {
      const value = saved[key];
      const env = process.env as Record<string, string | undefined>;
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

/**
 * A provisioning instant at a fixed local hour, so availability states (which depend on the time of day)
 * are deterministic: noon today in the demo timezone if that has already passed, otherwise noon yesterday.
 * Always in the past, so every seeded instant is too.
 */
export function stableNow(): Date {
  const local = utcToZoned(new Date(), DEMO_TIMEZONE);
  const date = local.minuteOfDay >= 12 * 60 + 5 ? local.date : addDays(local.date, -1);
  return zonedDateTimeToUtc(date, 12 * 60, DEMO_TIMEZONE);
}

/**
 * Runs `run` and returns every data-changing SQL statement this worker's pool issued meanwhile — a precise,
 * parallel-safe "wrote nothing" check (another test file's writes happen in another worker's pool, so a global
 * row count would be racy). Both pool-level queries and statements on a checked-out transaction client are seen.
 */
export async function capturedWrites(run: () => Promise<unknown>): Promise<string[]> {
  const pool = getPool();
  const statements: string[] = [];
  const textOf = (query: unknown) => (typeof query === 'string' ? query : String((query as { text?: unknown })?.text ?? ''));
  const record = (query: unknown) => statements.push(textOf(query));
  const wrapped = new WeakSet<object>();
  const wrap = <C extends { query: (...args: never[]) => unknown }>(client: C): C => {
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((query: unknown, ...rest: unknown[]) => {
        if (recording) record(query);
        return original(query, ...rest);
      }) as never;
    }
    return client;
  };
  let recording = true;
  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  // pg's own `pool.query` checks a client out with the CALLBACK form of `connect`; drizzle's transactions use the
  // promise form. Both are forwarded unchanged, with the client's `query` observed.
  const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(((callback?: (err: Error | undefined, client: never, done: never) => void) => {
    if (typeof callback === 'function') {
      return originalConnect((err: Error | undefined, client: never, done: never) => callback(err, client ? wrap(client) : client, done));
    }
    return (originalConnect() as Promise<never>).then((client) => wrap(client));
  }) as never);
  try {
    await run();
  } finally {
    recording = false;
    connectSpy.mockRestore();
  }
  return statements.filter((text) => /^\s*(insert|update|delete|truncate)\b/i.test(text));
}

/** spec 005's sliding refresh of the caller's own session — the one write any authenticated request makes. */
export const isSessionRefresh = (statement: string) => {
  const set = /^\s*update "sessions" set ([\s\S]*?) where /i.exec(statement)?.[1];
  return set !== undefined && /"expires_at" = /.test(set) && !/"revoked_at"/.test(set);
};

export async function countRows(table: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`);
  return row!.n;
}

export async function setUserIds(setId: string): Promise<string[]> {
  const rows = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM users WHERE demo_set_id = ${setId} ORDER BY id`);
  return rows.map((row) => row.id);
}
