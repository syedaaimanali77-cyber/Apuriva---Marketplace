import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from './index';

/**
 * Applies drizzle/0001_baseline_schema_down.sql — the hand-written reversal of
 * 0001_baseline_schema.sql (spec 003 §4: "safe pre-launch only"). Not a general migration
 * rollback tool; this only ever undoes the single baseline migration.
 *
 * Usage: npm run db:rollback
 */
async function main() {
  const downSql = readFileSync(join(__dirname, '..', '..', 'drizzle', '0001_baseline_schema_down.sql'), 'utf8');
  const pool = getPool();
  await pool.query(downSql);
  await pool.end();
  console.log('0001_baseline_schema rolled back.');
}

main().catch((err) => {
  console.error('Rollback failed:', err);
  process.exit(1);
});
