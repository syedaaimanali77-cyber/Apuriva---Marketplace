/**
 * Prepares `<name>_browser_demo` for the hosted-demo browser run, through the REAL operator path: it makes
 * sure the database exists (the reseed must connect to it to run its guards), then runs scripts/demo-reseed.ts,
 * which checks spec 045 §3.1 conditions 1–3 and "no non-demo user", drops and recreates ONLY that `_demo`
 * database and applies every migration.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { isDemoDatabaseName } from '@/lib/demo/guards';

async function main(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? '');
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!isDemoDatabaseName(name)) throw new Error(`prepare-demo-database: refusing "${name}" — not a _demo database.`);

  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  const root = path.join(__dirname, '..', '..');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'demo-reseed.ts')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
