/**
 * Test-database isolation. Integration tests write into whatever `DATABASE_URL` names, and
 * `test/db-reset.ts` drops and recreates it — so Vitest must never see the developer's normal
 * database (the one `next dev` reads). `vitest.config.ts` rewrites `DATABASE_URL` to a sibling
 * `<name>_test` database before global setup or any worker runs, and `db-reset.ts` refuses to
 * touch a database that isn't named `*_test`.
 */
export const TEST_DATABASE_SUFFIX = '_test';

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

/** `postgresql://…/apuriva` → `postgresql://…/apuriva_test`. An already-isolated URL is returned unchanged. */
export function toTestDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = databaseName(url);
  if (!name) throw new Error('DATABASE_URL has no database name, so no isolated test database can be derived from it.');
  if (name.endsWith(TEST_DATABASE_SUFFIX)) return databaseUrl;
  url.pathname = `/${name}${TEST_DATABASE_SUFFIX}`;
  return url.toString();
}

/** Returns the database name, or throws unless `databaseUrl` names an isolated `*_test` database. */
export function assertTestDatabaseUrl(databaseUrl: string): string {
  const name = databaseName(new URL(databaseUrl));
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to use database "${name}" for tests: only databases named *${TEST_DATABASE_SUFFIX} may be reset. ` +
        'Run tests through vitest.config.ts, which points DATABASE_URL at an isolated test database.',
    );
  }
  return name;
}
