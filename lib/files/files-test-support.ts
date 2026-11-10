/**
 * Spec 027 — shared fixtures for this domain's suites. Writes only to the isolated `*_test` database
 * Vitest points `DATABASE_URL` at (test/db-reset.ts), and to the local adapter’s OS temp directory
 * for bytes, so
 * a test never touches the developer's own database or leaves anything in the repository.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { localStorageDir } from './config';
import { registerShippedFileContextPolicies, resetFileContextPolicies } from './index';
import { queryRows } from './sql';
import type { FileAssetRow } from './assets';
import { FILE_ASSET_COLUMNS } from './assets';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** The minimal valid header bytes for each allowlisted type, so `finalize`'s sniff succeeds. */
export const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
export const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
export const PDF_HEADER = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
export const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);

export function jpegBytes(totalBytes = 64): Buffer {
  return Buffer.concat([JPEG_HEADER, Buffer.alloc(Math.max(0, totalBytes - JPEG_HEADER.length), 0x41)]);
}

export function pdfBytes(totalBytes = 128): Buffer {
  return Buffer.concat([PDF_HEADER, Buffer.alloc(Math.max(0, totalBytes - PDF_HEADER.length), 0x20)]);
}

/** A JPEG whose payload carries a scanner marker — the bytes are still a valid JPEG header. */
export function jpegWithMarker(marker: string): Buffer {
  return Buffer.concat([JPEG_HEADER, Buffer.from(marker, 'latin1'), Buffer.alloc(16, 0x41)]);
}

/**
 * Makes sure the local adapter's directory exists, and returns it.
 *
 * It deliberately does NOT point the adapter at a per-suite temporary directory, which is what this
 * helper used to do. Vitest's `threads` pool gives each worker its own copy of `process.env`, so a
 * per-suite `FILE_STORAGE_LOCAL_DIR` diverges BETWEEN worker threads — and
 * `runFileMaintenanceSweep()` is global, claiming due rows from every suite. A sweep running in
 * thread B would therefore scan thread A's asset against thread B's directory, find no bytes, and
 * (before the scanner learned to report `unknown` for an unreadable object) call it clean.
 *
 * Every suite resolving the SAME directory removes that divergence entirely. Nothing collides:
 * storage keys are `<userId>/<uuid>`, so two suites can never write the same object.
 */
export function useTemporaryStorageDir(): { dir: string; cleanup: () => void } {
  const dir = localStorageDir();
  mkdirSync(dir, { recursive: true });
  // Nothing to restore: no environment variable was changed, and the directory is shared.
  return { dir, cleanup: () => undefined };
}

/** Registers the shipped policies for a suite that exercises them, from a known-clean registry. */
export function withShippedPolicies(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

export async function createUser(): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO users (email) VALUES (${`files-${randomUUID()}@example.test`}) RETURNING id`,
  );
  return row!.id;
}

/** Idempotent: a user registered through the real auth route already has a customer profile. */
export async function createCustomerProfile(userId: string): Promise<string> {
  const [existing] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM customer_profiles WHERE user_id = ${userId}`,
  );
  if (existing) return existing.id;
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO customer_profiles (user_id) VALUES (${userId}) RETURNING id`,
  );
  return row!.id;
}

/** Idempotent for the same reason as `createCustomerProfile`. */
export async function createProviderProfile(userId: string): Promise<string> {
  const [existing] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM provider_profiles WHERE user_id = ${userId}`,
  );
  if (existing) return existing.id;
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO provider_profiles (user_id, business_name, lifecycle_status)
        VALUES (${userId}, ${`Provider ${randomUUID().slice(0, 8)}`}, 'active') RETURNING id`,
  );
  return row!.id;
}

/** Seeds the catalog + address FK chain one `requests` row needs, and returns the request id. */
export async function createRequestOwnedBy(userId: string): Promise<string> {
  const db = getDb();
  const customerProfileId = await createCustomerProfile(userId);
  const suffix = randomUUID().slice(0, 8);

  const [category] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO categories (name, slug) VALUES (${`Cat ${suffix}`}, ${`cat-${suffix}`}) RETURNING id`,
  );
  const [subcategory] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO subcategories (category_id, name, slug)
        VALUES (${category!.id}, ${`Sub ${suffix}`}, ${`sub-${suffix}`}) RETURNING id`,
  );
  const [service] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO services (category_id, subcategory_id, name, slug)
        VALUES (${category!.id}, ${subcategory!.id}, ${`Svc ${suffix}`}, ${`svc-${suffix}`}) RETURNING id`,
  );
  const [location] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO locations (latitude_micro_degrees, longitude_micro_degrees)
        VALUES (31520000, 74358000) RETURNING id`,
  );
  const [address] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO addresses (user_id, location_id, label, structured)
        VALUES (${userId}, ${location!.id}, 'Test', ${JSON.stringify({ area: 'A', city: 'C', country: 'P' })}::jsonb)
        RETURNING id`,
  );
  const [request] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO requests (customer_profile_id, service_id, status, description, address_id, urgency,
                              idempotency_key, idempotency_fingerprint)
        VALUES (${customerProfileId}, ${service!.id}, 'draft', 'Seeded request', ${address!.id}, 'normal',
                ${`seed-${randomUUID()}`}, 'seed-fingerprint')
        RETURNING id`,
  );
  return request!.id;
}

export async function loadAsset(fileAssetId: string): Promise<FileAssetRow | null> {
  const [row] = await queryRows<FileAssetRow>(
    getDb(),
    sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets WHERE id = ${fileAssetId}`,
  );
  return row ?? null;
}

/** Makes a queued scan due NOW, skipping the backoff wait. */
export async function makeScanDue(fileAssetId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE file_assets SET scan_next_attempt_at = clock_timestamp() - interval '1 second'
     WHERE id = ${fileAssetId} AND status = 'scanning' AND scan_next_attempt_at IS NOT NULL
  `);
}

/** Back-dates a soft deletion so the purge pass considers it past the grace period. */
export async function backdateDeletion(fileAssetId: string, days: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE file_assets SET deleted_at = clock_timestamp() - make_interval(days => ${days})
     WHERE id = ${fileAssetId}
  `);
}

export async function setLegalHold(fileAssetId: string, value: boolean): Promise<void> {
  await getDb().execute(sql`UPDATE file_assets SET legal_hold = ${value} WHERE id = ${fileAssetId}`);
}
