import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { assertTestDatabaseUrl } from '@/test/test-database';
import { countNonDemoUsers } from './operator';
import { isDatabaseReachable } from './demo-test-support';

/**
 * Spec 045 §3.5 — the reseed guard on the databases an operator actually meets. The first deploy of a demo
 * environment starts from an EMPTY `_demo` database with no tables at all; the guard must let the reseed
 * initialise it (a defect found by the hosted-demo browser run: it queried a `users` table that did not
 * exist and the reseed could never start). Runs in a throwaway `*_test` database of its own.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('countNonDemoUsers on fresh and pre-0039 databases (spec 045 §3.5)', () => {
  const baseUrl = new URL(process.env.DATABASE_URL!);
  const baseName = decodeURIComponent(baseUrl.pathname.replace(/^\//, ''));
  const scratchName = `${baseName.replace(/_test$/, '')}_demofresh_test`;
  const scratchUrl = new URL(baseUrl.toString());
  scratchUrl.pathname = `/${scratchName}`;
  const adminUrl = new URL(baseUrl.toString());
  adminUrl.pathname = '/postgres';
  let scratch: Client;

  beforeAll(async () => {
    assertTestDatabaseUrl(scratchUrl.toString());
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    await admin.end();
    scratch = new Client({ connectionString: scratchUrl.toString() });
    await scratch.connect();
  });

  afterAll(async () => {
    await scratch?.end();
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.end();
  });

  it('an empty database (no tables yet) has no non-demo user, so the reseed may initialise it', async () => {
    expect(await countNonDemoUsers(drizzle(scratch))).toBe(0);
  });

  it('a database without the is_demo column counts every user as a real one', async () => {
    await scratch.query('CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await scratch.query('INSERT INTO users DEFAULT VALUES');
    await scratch.query('INSERT INTO users DEFAULT VALUES');
    expect(await countNonDemoUsers(drizzle(scratch))).toBe(2);
  });

  it('with is_demo, only non-demo users count', async () => {
    await scratch.query('ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false');
    await scratch.query('UPDATE users SET is_demo = true');
    await scratch.query('INSERT INTO users (is_demo) VALUES (false)');
    expect(await countNonDemoUsers(drizzle(scratch))).toBe(1);
  });
});
