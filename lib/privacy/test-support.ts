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

  const { rows: categoryRows } = await pool.query<{ id: string }>('INSERT INTO categories DEFAULT VALUES RETURNING id');
  const { rows: subcategoryRows } = await pool.query<{ id: string }>(
    'INSERT INTO subcategories (category_id) VALUES ($1) RETURNING id',
    [categoryRows[0]!.id],
  );
  const { rows: serviceRows } = await pool.query<{ id: string }>(
    'INSERT INTO services (subcategory_id) VALUES ($1) RETURNING id',
    [subcategoryRows[0]!.id],
  );

  const { rows: requestRows } = await pool.query<{ id: string }>(
    'INSERT INTO requests (customer_profile_id, service_id, status) VALUES ($1, $2, $3) RETURNING id',
    [customerProfileId, serviceRows[0]!.id, 'draft'],
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
