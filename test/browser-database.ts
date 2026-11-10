import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { assertTestDatabaseUrl, TEST_DATABASE_SUFFIX } from './test-database';

/**
 * Spec 046 §3.6 — the Playwright browser tests' own database. It is NEVER the developer's database
 * (the one `next dev` reads) and NEVER Vitest's `<name>_test` database, which a concurrent Vitest run
 * resets: it is a sibling `<name>_browser_test`, so it also satisfies the repository-wide rule that
 * only databases named `*_test` may be reset.
 */
export const BROWSER_DATABASE_SUFFIX = '_browser_test';

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

export function toBrowserDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  let name = databaseName(url);
  if (!name) throw new Error('DATABASE_URL has no database name, so no browser test database can be derived from it.');
  if (name.endsWith(BROWSER_DATABASE_SUFFIX)) return databaseUrl;
  if (name.endsWith(TEST_DATABASE_SUFFIX)) name = name.slice(0, -TEST_DATABASE_SUFFIX.length);
  url.pathname = `/${name}${BROWSER_DATABASE_SUFFIX}`;
  return url.toString();
}

/** Throws unless `databaseUrl` names a local `*_browser_test` database. Returns its name. */
export function assertBrowserDatabaseUrl(databaseUrl: string): string {
  const name = assertTestDatabaseUrl(databaseUrl);
  if (!name.endsWith(BROWSER_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to reset "${name}" for browser tests: only databases named *${BROWSER_DATABASE_SUFFIX} may be used.`);
  }
  const host = new URL(databaseUrl).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`Refusing to reset a browser test database on a non-local host ("${host}").`);
  }
  return name;
}

/** Drops, recreates and migrates the browser test database — before the web server starts. */
export async function resetBrowserDatabase(databaseUrl: string): Promise<void> {
  const name = assertBrowserDatabaseUrl(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  } finally {
    await client.end();
  }
}
