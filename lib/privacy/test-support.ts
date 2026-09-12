import { randomUUID } from 'node:crypto';
import { getPool } from '@/lib/db';
import { registerFileAssetStorage, type FileAssetStorage } from './file-asset-storage';

/**
 * TEST FIXTURE ONLY — stands in for spec 027's not-yet-implemented `FileAssetStorage` capability
 * (lib/privacy/file-asset-storage.ts), the same way a test stubs any other external dependency
 * (a payment gateway, an email provider). This is not a second production storage backend: it is
 * never registered outside a test, and lib/privacy/export.ts never imports it — only
 * `registerFileAssetStorage` (the same registration seam spec 027's real implementation will use).
 */
export function registerTestFileAssetStorage(): void {
  const store = new Map<string, string>();
  const fixture: FileAssetStorage = {
    async store(fileAssetId, content) {
      store.set(fileAssetId, content);
    },
    async retrieve(fileAssetId) {
      return store.get(fileAssetId) ?? null;
    },
  };
  registerFileAssetStorage(fixture);
}

/** Minimal user + customer_profile row, bypassing the HTTP registration flow — lib/privacy
 * tests operate directly on ids, not sessions. */
export async function seedUser(): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = rows[0]!.id;
  await pool.query('INSERT INTO customer_profiles (user_id) VALUES ($1)', [userId]);
  return userId;
}

/** Seeds the minimal FK chain a `bookings` row needs (service catalog + a request + an offer)
 * with `customerUserId` as the customer, a fresh provider as the provider, and `status` on the
 * booking itself. */
export async function seedBooking(customerUserId: string, status: string): Promise<{ bookingId: string; providerUserId: string }> {
  const pool = getPool();

  const { rows: customerProfileRows } = await pool.query<{ id: string }>(
    'SELECT id FROM customer_profiles WHERE user_id = $1',
    [customerUserId],
  );
  const customerProfileId = customerProfileRows[0]!.id;

  const { rows: providerUserRows } = await pool.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  const providerUserId = providerUserRows[0]!.id;
  const { rows: providerProfileRows } = await pool.query<{ id: string }>(
    'INSERT INTO provider_profiles (user_id) VALUES ($1) RETURNING id',
    [providerUserId],
  );
  const providerProfileId = providerProfileRows[0]!.id;

  // Spec 010 gave the catalog tables real `not null` name/slug columns; spec 015 gave `requests`
  // its own feature columns (description/address/urgency/idempotency). Both are reflected here so
  // this fixture keeps building the minimal FK chain a booking needs.
  const suffix = randomUUID().slice(0, 8);
  const { rows: categoryRows } = await pool.query<{ id: string }>(
    'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
    [`Privacy Category ${suffix}`, `privacy-category-${suffix}`],
  );
  const { rows: subcategoryRows } = await pool.query<{ id: string }>(
    'INSERT INTO subcategories (category_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [categoryRows[0]!.id, `Privacy Subcategory ${suffix}`, `privacy-subcategory-${suffix}`],
  );
  const { rows: serviceRows } = await pool.query<{ id: string }>(
    'INSERT INTO services (category_id, subcategory_id, name, slug) VALUES ($1, $2, $3, $4) RETURNING id',
    [categoryRows[0]!.id, subcategoryRows[0]!.id, `Privacy Service ${suffix}`, `privacy-service-${suffix}`],
  );

  const { rows: locationRows } = await pool.query<{ id: string }>(
    'INSERT INTO locations (latitude_micro_degrees, longitude_micro_degrees) VALUES ($1, $2) RETURNING id',
    [31_520_000, 74_358_000],
  );
  const { rows: addressRows } = await pool.query<{ id: string }>(
    'INSERT INTO addresses (user_id, location_id, label, structured) VALUES ($1, $2, $3, $4) RETURNING id',
    [customerUserId, locationRows[0]!.id, 'Home', JSON.stringify({ area: 'Area', city: 'City', country: 'Country' })],
  );

  const { rows: requestRows } = await pool.query<{ id: string }>(
    `INSERT INTO requests
       (customer_profile_id, service_id, status, description, address_id, urgency, idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, $3, $4, $5, 'normal', $6, $7)
     RETURNING id`,
    [
      customerProfileId,
      serviceRows[0]!.id,
      'draft',
      'Seeded privacy-fixture request',
      addressRows[0]!.id,
      `privacy-seed-${randomUUID()}`,
      'privacy-seed-fingerprint',
    ],
  );
  const { rows: offerRows } = await pool.query<{ id: string }>(
    'INSERT INTO offers (request_id, provider_profile_id, status) VALUES ($1, $2, $3) RETURNING id',
    [requestRows[0]!.id, providerProfileId, 'draft'],
  );
  const { rows: bookingRows } = await pool.query<{ id: string }>(
    'INSERT INTO bookings (offer_id, status) VALUES ($1, $2) RETURNING id',
    [offerRows[0]!.id, status],
  );

  return { bookingId: bookingRows[0]!.id, providerUserId };
}
