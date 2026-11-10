import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  addresses,
  categories,
  locations,
  providerAvailabilities,
  providerProfiles,
  providerServices,
  services,
} from '@/lib/db/schema';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { POST as CREATE_PROVIDER_PROFILE } from '@/app/api/v1/users/me/provider-profile/route';
import { PATCH as SWITCH_MODE } from '@/app/api/v1/users/me/active-mode/route';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';
export { registerAndLogin };
export type { TestSession };

/**
 * Spec 016 §6 fixtures. Catalog, address and provider-side rows are seeded directly at the DB
 * layer — the same "test-setup shortcut" pattern `app/api/v1/requests/requests-test-support.ts`
 * uses — because these suites exercise the AVAILABILITY endpoints, not spec 010's catalog CRUD or
 * spec 012's address CRUD, which have their own integration tests.
 *
 * Every test runs against the isolated `<name>_test` database (`vitest.config.ts` rewrites
 * `DATABASE_URL`; `test/db-reset.ts` refuses any other name).
 */

/** Lahore's Gulberg, the point spec 016 §3 S3's "Lahore + 20 km" example is anchored on. */
export const LAHORE = { latitudeMicroDegrees: 31_520_000, longitudeMicroDegrees: 74_358_000 };
/** Islamabad — roughly 270 km from Lahore, comfortably outside any 20 km radius. */
export const ISLAMABAD = { latitudeMicroDegrees: 33_684_000, longitudeMicroDegrees: 73_047_000 };
/** ~9 km from the Lahore point: inside a 20 km radius, outside a 5 km one. */
export const LAHORE_NEARBY = { latitudeMicroDegrees: 31_600_000, longitudeMicroDegrees: 74_358_000 };

export interface ProviderFixture extends TestSession {
  providerProfileId: string;
}

/** A registered account with a provider profile, switched into provider mode. */
export async function registerProvider(options?: { lifecycleStatus?: string; timezone?: string }): Promise<ProviderFixture> {
  const session = await registerAndLogin();

  const created = await CREATE_PROVIDER_PROFILE(
    authenticatedRequest('http://localhost/api/v1/users/me/provider-profile', session.sessionId, session.csrfToken, {
      method: 'POST',
    }),
  );
  const { data } = await created.json();

  await SWITCH_MODE(
    authenticatedRequest('http://localhost/api/v1/users/me/active-mode', session.sessionId, session.csrfToken, {
      method: 'PATCH',
      body: { mode: 'provider' },
    }),
  );

  await getDb()
    .update(providerProfiles)
    .set({
      lifecycleStatus: (options?.lifecycleStatus ?? 'active') as 'active',
      schedulingTimezone: options?.timezone ?? 'Asia/Karachi',
    })
    .where(eq(providerProfiles.id, data.id));

  return { ...session, providerProfileId: data.id };
}

/** A registered customer, left in the default customer mode. */
export async function registerCustomer(): Promise<TestSession> {
  return registerAndLogin();
}

/** A published service the provider offers, with the given duration and buffers. */
export async function seedProviderService(
  providerProfileId: string,
  options?: { durationMinutes?: number; bufferBeforeMinutes?: number; bufferAfterMinutes?: number },
): Promise<{ serviceId: string }> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);

  const [category] = await db
    .insert(categories)
    .values({ name: `Avail Category ${suffix}`, slug: `avail-category-${suffix}`, status: 'published' })
    .returning({ id: categories.id });

  const [service] = await db
    .insert(services)
    .values({
      categoryId: category!.id,
      name: `Avail Service ${suffix}`,
      slug: `avail-service-${suffix}`,
      pricingModel: 'quote',
      status: 'published',
    })
    .returning({ id: services.id });

  await db.insert(providerServices).values({
    providerProfileId,
    serviceId: service!.id,
    durationMinutes: options?.durationMinutes ?? 60,
    bufferBeforeMinutes: options?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: options?.bufferAfterMinutes ?? 0,
  });

  return { serviceId: service!.id };
}

/** A service that exists but which the provider does NOT offer. */
export async function seedForeignService(): Promise<{ serviceId: string }> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [category] = await db
    .insert(categories)
    .values({ name: `Other Category ${suffix}`, slug: `other-category-${suffix}`, status: 'published' })
    .returning({ id: categories.id });
  const [service] = await db
    .insert(services)
    .values({
      categoryId: category!.id,
      name: `Other Service ${suffix}`,
      slug: `other-service-${suffix}`,
      pricingModel: 'quote',
      status: 'published',
    })
    .returning({ id: services.id });
  return { serviceId: service!.id };
}

/** A saved address at a given point, owned by `userId` (spec 012's model). */
export async function seedAddressAt(
  userId: string,
  point: { latitudeMicroDegrees: number; longitudeMicroDegrees: number },
  city = 'Lahore',
): Promise<{ addressId: string }> {
  const db = getDb();
  const [location] = await db
    .insert(locations)
    .values({ ...point, geoHierarchy: { area: 'Gulberg', city, country: 'Pakistan' } })
    .returning({ id: locations.id });

  const [address] = await db
    .insert(addresses)
    .values({
      userId,
      locationId: location!.id,
      label: 'Base',
      structured: { area: 'Gulberg', city, country: 'Pakistan' },
      isDefault: true,
    })
    .returning({ id: addresses.id });

  return { addressId: address!.id };
}

/** Weekly hours written straight at the DB, for suites not exercising the schedule route. */
export async function seedWeeklyHours(
  providerProfileId: string,
  entries: { dayOfWeek: number; startMinute: number; endMinute: number }[],
): Promise<void> {
  if (entries.length === 0) return;
  await getDb()
    .insert(providerAvailabilities)
    .values(entries.map((entry) => ({ providerProfileId, ...entry })));
}

/** Every day of the week, 00:00–24:00 — "always available", for tests about something else. */
export function allWeekAlwaysOpen(): { dayOfWeek: number; startMinute: number; endMinute: number }[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startMinute: 0, endMinute: 1440 }));
}

/** A GET carrying the session cookie (no CSRF header — GETs change no state). */
export function sessionGet(url: string, session: TestSession): Request {
  return new Request(url, { method: 'GET', headers: { cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}` } });
}

/** A guest (unauthenticated) GET. */
export function guestGet(url: string): Request {
  return new Request(url, { method: 'GET' });
}

/** A state-changing request carrying both the session cookie and the CSRF header. */
export function sessionMutate(
  url: string,
  session: TestSession,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
      [CSRF_HEADER_NAME]: session.csrfToken,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
