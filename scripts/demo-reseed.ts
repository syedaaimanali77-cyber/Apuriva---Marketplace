/**
 * Spec 045 §3.5 — the operator-only environment reseed. Never an HTTP route.
 *
 * Usage (on the demo deployment's environment): npx tsx scripts/demo-reseed.ts
 *
 * Refuses unless APP_ENV is not production, the demo-mode flag is on, the DATABASE_URL database name ends in
 * `_demo`, and that database holds no non-demo user. Then it drops and recreates ONLY that `_demo` database and
 * applies every migration (the same migrator as `npm run db:migrate`), which re-seeds the catalog and flags.
 * Demo sets are created again on demand by POST /api/v1/demo/login. Recommended: nightly and on each demo deploy.
 */
import 'dotenv/config';
import path from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getPool } from '@/lib/db';
import { isDemoDatabaseName } from '@/lib/demo/guards';
import { DemoOperatorRefusal, reseedDemoEnvironment } from '@/lib/demo/operator';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL!;
  await reseedDemoEnvironment({
    async dropAndRecreate(databaseName) {
      // Belt and braces: the guard already checked the suffix; never drop anything else.
      if (!isDemoDatabaseName(databaseName)) throw new Error(`Refusing to drop "${databaseName}".`);
      await getPool().end();
      const adminUrl = new URL(url);
      adminUrl.pathname = '/postgres';
      const admin = new Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${databaseName}"`);
      } finally {
        await admin.end();
      }
    },
    async migrate() {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
      } finally {
        await client.end();
      }
    },
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof DemoOperatorRefusal ? err.message : err);
    process.exit(1);
  },
);
