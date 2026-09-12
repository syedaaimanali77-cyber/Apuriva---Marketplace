import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { assertTestDatabaseUrl } from './test-database';

/**
 * Integration tests (`*.integration.test.ts`) write directly into `DATABASE_URL` with no per-test
 * transaction rollback (see `lib/db/test-support.ts`'s `isDatabaseReachable`). Under Vitest that
 * is always an isolated `<name>_test` database, never the one `next dev` reads — `vitest.config.ts`
 * rewrites `DATABASE_URL` before this runs (see `test/test-database.ts`). Left unchecked,
 * every local test run permanently adds more fixture rows (categories named "Cat", "FAQ Test",
 * "Untitled", ...) that legitimately have `status: 'published'` and so legitimately satisfy the
 * homepage/search's real published+active filters — they were never a query bug, just accumulated
 * data. Dropping and recreating the database from migrations before and after the suite keeps it
 * at exactly the state migrations define (real baseline categories/services, no fixture residue),
 * regardless of what any previous run left behind. Guarded to loopback hosts only, so this can
 * never run against a non-local database, and to `*_test` database names only, so it can never
 * drop the developer's normal database even if `DATABASE_URL` reaches it unrewritten.
 */
async function resetDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  // Throws — failing the whole run before any test executes — rather than resetting a database
  // that isn't an isolated test database.
  const dbName = assertTestDatabaseUrl(url);

  const target = new URL(url);
  if (target.hostname !== 'localhost' && target.hostname !== '127.0.0.1') return;

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
  } catch {
    return; // No local Postgres running — integration tests themselves already skip via isDatabaseReachable().
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const migrateClient = new Client({ connectionString: url });
  await migrateClient.connect();
  try {
    await migrate(drizzle(migrateClient), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  } finally {
    await migrateClient.end();
  }
}

export async function setup(): Promise<void> {
  await resetDatabase();
}

export async function teardown(): Promise<void> {
  await resetDatabase();
}
