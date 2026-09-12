import { randomUUID } from 'node:crypto';
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

  // Spec 010 gave the catalog tables their real `not null` name/slug columns (and `services` its
  // own `category_id`), so the original `DEFAULT VALUES` inserts here no longer satisfy the
  // schema. Slugs are unique catalog-wide, hence the per-call random suffix.
  const suffix = randomUUID().slice(0, 8);
  const { rows: categoryRows } = await client.query<{ id: string }>(
    'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
    [`Seed Category ${suffix}`, `seed-category-${suffix}`],
  );
  const { rows: subcategoryRows } = await client.query<{ id: string }>(
    'INSERT INTO subcategories (category_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [categoryRows[0]!.id, `Seed Subcategory ${suffix}`, `seed-subcategory-${suffix}`],
  );
  const { rows: serviceRows } = await client.query<{ id: string }>(
    'INSERT INTO services (category_id, subcategory_id, name, slug) VALUES ($1, $2, $3, $4) RETURNING id',
    [categoryRows[0]!.id, subcategoryRows[0]!.id, `Seed Service ${suffix}`, `seed-service-${suffix}`],
  );

  // Spec 015 §4 added the request's own feature columns, several of them `not null` — so the FK
  // chain a `requests` row needs now includes a location + address too. The values below are the
  // minimum that satisfies those constraints; no test should read meaning into them.
  const { rows: locationRows } = await client.query<{ id: string }>(
    'INSERT INTO locations (latitude_micro_degrees, longitude_micro_degrees) VALUES ($1, $2) RETURNING id',
    [31_520_000, 74_358_000],
  );
  const { rows: addressRows } = await client.query<{ id: string }>(
    `INSERT INTO addresses (user_id, location_id, label, structured) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, locationRows[0]!.id, 'Test', JSON.stringify({ area: 'Area', city: 'City', country: 'Country' })],
  );

  const { rows: requestRows } = await client.query<{ id: string }>(
    `INSERT INTO requests
       (customer_profile_id, service_id, status, description, address_id, urgency, idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'normal', $6, $7)
     RETURNING id`,
    [
      customerProfileId,
      serviceRows[0]!.id,
      initialStatus,
      'Seeded request',
      addressRows[0]!.id,
      `seed-${randomUUID()}`,
      'seed-fingerprint',
    ],
  );
  return requestRows[0]!.id;
}
