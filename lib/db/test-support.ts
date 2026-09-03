import type { PoolClient } from 'pg';
import { getPool } from './index';

/**
 * Integration tests need a real Postgres with 0001_baseline_schema already applied
 * (`docker compose up -d && npm run db:migrate`). Rather than hard-failing with a connection
 * error when no DB is running — which would break `npm test` for anyone without Docker up —
 * each integration suite checks this first and skips (not fails) if unreachable.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Seeds the minimal FK chain a `requests` row needs (user -> customer_profile,
 * category -> subcategory -> service), inside the caller's transaction/client, for
 * integration tests that need one real `requests` row without re-deriving the chain
 * every time. Returns the new `requests.id`.
 */
export async function seedMinimalRequest(client: PoolClient, initialStatus: string): Promise<string> {
  const { rows: userRows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = userRows[0]!.id;

  const { rows: customerRows } = await client.query<{ id: string }>(
    'INSERT INTO customer_profiles (user_id) VALUES ($1) RETURNING id',
    [userId],
  );
  const customerProfileId = customerRows[0]!.id;

  const { rows: categoryRows } = await client.query<{ id: string }>('INSERT INTO categories DEFAULT VALUES RETURNING id');
  const { rows: subcategoryRows } = await client.query<{ id: string }>(
    'INSERT INTO subcategories (category_id) VALUES ($1) RETURNING id',
    [categoryRows[0]!.id],
  );
  const { rows: serviceRows } = await client.query<{ id: string }>(
    'INSERT INTO services (subcategory_id) VALUES ($1) RETURNING id',
    [subcategoryRows[0]!.id],
  );

  const { rows: requestRows } = await client.query<{ id: string }>(
    'INSERT INTO requests (customer_profile_id, service_id, status) VALUES ($1, $2, $3) RETURNING id',
    [customerProfileId, serviceRows[0]!.id, initialStatus],
  );
  return requestRows[0]!.id;
}
