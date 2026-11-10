import { randomUUID } from 'node:crypto';
import { getPool } from '@/lib/db';

export { authenticatedRequest, isDatabaseReachable, uniqueEmail } from '@/app/api/v1/auth/test-support';
export { registerAndLogin } from '@/app/api/v1/location/location-test-support';

/**
 * Raw-SQL seed helpers for search integration tests. Not reusing `lib/db/test-support.ts`'s
 * `seedMinimalRequest` — it does `INSERT INTO categories DEFAULT VALUES`, which spec 010's later
 * `categories.name`/`slug NOT NULL` columns broke (a pre-existing, unrelated regression — see the
 * spec 013 implementation report). These helpers supply every required column directly.
 */

function unique(base: string): string {
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export async function createCategory(overrides: { name?: string; status?: string; sortOrder?: number } = {}): Promise<string> {
  const name = overrides.name ?? unique('Category');
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO categories (name, slug, status, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, unique('cat'), overrides.status ?? 'published', overrides.sortOrder ?? 0],
  );
  return rows[0]!.id;
}

export async function createService(
  categoryId: string,
  overrides: { name?: string; status?: string; pricingModel?: string } = {},
): Promise<string> {
  const name = overrides.name ?? unique('Service');
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO services (category_id, name, slug, pricing_model, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [categoryId, name, unique('svc'), overrides.pricingModel ?? 'fixed', overrides.status ?? 'published'],
  );
  return rows[0]!.id;
}

export async function createProviderProfile(
  overrides: { businessName?: string; lifecycleStatus?: string } = {},
): Promise<{ providerProfileId: string; userId: string }> {
  const { rows: userRows } = await getPool().query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  const userId = userRows[0]!.id;
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO provider_profiles (user_id, business_name, lifecycle_status) VALUES ($1, $2, $3) RETURNING id',
    [userId, overrides.businessName ?? unique('Provider'), overrides.lifecycleStatus ?? 'active'],
  );
  return { providerProfileId: rows[0]!.id, userId };
}

export async function linkProviderService(providerProfileId: string, serviceId: string): Promise<void> {
  await getPool().query('INSERT INTO provider_services (provider_profile_id, service_id) VALUES ($1, $2)', [
    providerProfileId,
    serviceId,
  ]);
}

export async function createServicePackage(
  serviceId: string,
  providerProfileId: string | null,
  amountMinorUnits: number,
  currencyCode = 'PKR',
): Promise<void> {
  await getPool().query(
    'INSERT INTO service_packages (service_id, provider_profile_id, name, amount_minor_units, currency_code) VALUES ($1, $2, $3, $4, $5)',
    [serviceId, providerProfileId, 'Package', amountMinorUnits, currencyCode],
  );
}

/** Gives a provider's user a default address (spec 012 tables) at the given point, so
 * distance/radius search has a real location to resolve. */
export async function giveUserDefaultAddress(userId: string, latitude: number, longitude: number, city = 'Lahore'): Promise<void> {
  const latMicro = Math.round(latitude * 1_000_000);
  const lngMicro = Math.round(longitude * 1_000_000);
  const { rows: locationRows } = await getPool().query<{ id: string }>(
    "INSERT INTO locations (latitude_micro_degrees, longitude_micro_degrees, geo_hierarchy) VALUES ($1, $2, $3) RETURNING id",
    [latMicro, lngMicro, JSON.stringify({ area: 'Area', city, country: 'Pakistan' })],
  );
  await getPool().query(
    "INSERT INTO addresses (user_id, location_id, label, structured, is_default) VALUES ($1, $2, $3, $4, true)",
    [userId, locationRows[0]!.id, 'Business', JSON.stringify({ area: 'Area', city, country: 'Pakistan' })],
  );
}
