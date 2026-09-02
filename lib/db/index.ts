import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

let pool: Pool | undefined;

/** Lazily-created, process-wide connection pool. One pool per process, per environment's DATABASE_URL. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
