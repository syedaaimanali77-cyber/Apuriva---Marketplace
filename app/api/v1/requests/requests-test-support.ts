import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { addresses, categories, customerProfiles, locations, serviceFields, services } from '@/lib/db/schema';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import type { CreateRequestRequest } from '@/lib/types/requests';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';
export { registerAndLogin };
export type { TestSession };

/**
 * Spec 015 §6 fixtures. Catalog and address rows are seeded directly at the DB layer — the same
 * "test-setup shortcut" pattern `app/api/v1/admin/admin-rbac-test-support.ts` uses for admin
 * profiles/roles — because this suite is exercising the *request* endpoints, not spec 010's
 * catalog CRUD or spec 012's address CRUD, which have their own integration tests.
 *
 * Every test runs against the isolated `<name>_test` database (`vitest.config.ts` rewrites
 * `DATABASE_URL`; `test/db-reset.ts` refuses any other name).
 */

export interface TestService {
  id: string;
  name: string;
  /** The `ServiceField.key`s seeded below, in definition order. */
  requiredTextKey: string;
  optionalSelectKey: string;
}

/** A published category + service, with one required text field and one optional select field. */
export async function seedPublishedService(options?: { withFields?: boolean }): Promise<TestService> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);

  const [category] = await db
    .insert(categories)
    .values({ name: `Test Category ${suffix}`, slug: `test-category-${suffix}`, status: 'published' })
    .returning({ id: categories.id });

  const [service] = await db
    .insert(services)
    .values({
      categoryId: category!.id,
      name: `Test Service ${suffix}`,
      slug: `test-service-${suffix}`,
      pricingModel: 'quote',
      status: 'published',
    })
    .returning({ id: services.id, name: services.name });

  const requiredTextKey = 'problem';
  const optionalSelectKey = 'access';

  if (options?.withFields !== false) {
    await db.insert(serviceFields).values([
      {
        serviceId: service!.id,
        key: requiredTextKey,
        label: 'What is the problem',
        type: 'text',
        required: true,
        sortOrder: 0,
      },
      {
        serviceId: service!.id,
        key: optionalSelectKey,
        label: 'Access',
        type: 'select',
        required: false,
        options: ['Someone home', 'Key with neighbour'],
        sortOrder: 1,
      },
    ]);
  }

  return { id: service!.id, name: service!.name, requiredTextKey, optionalSelectKey };
}

/** A draft (unpublished) service — never requestable (spec 015 §3 `serviceId` validation). */
export async function seedDraftService(): Promise<{ id: string }> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [category] = await db
    .insert(categories)
    .values({ name: `Draft Category ${suffix}`, slug: `draft-category-${suffix}`, status: 'published' })
    .returning({ id: categories.id });
  const [service] = await db
    .insert(services)
    .values({
      categoryId: category!.id,
      name: `Draft Service ${suffix}`,
      slug: `draft-service-${suffix}`,
      pricingModel: 'quote',
      status: 'draft',
    })
    .returning({ id: services.id });
  return { id: service!.id };
}

/** One saved address belonging to `userId` (spec 012's model — never a second address concept). */
export async function seedAddress(userId: string): Promise<{ id: string }> {
  const db = getDb();
  const [location] = await db
    .insert(locations)
    .values({
      latitudeMicroDegrees: 31_520_000,
      longitudeMicroDegrees: 74_358_000,
      geoHierarchy: { area: 'Gulberg', city: 'Lahore', country: 'Pakistan' },
    })
    .returning({ id: locations.id });

  const [address] = await db
    .insert(addresses)
    .values({
      userId,
      locationId: location!.id,
      label: 'Home',
      structured: { area: 'Gulberg', city: 'Lahore', country: 'Pakistan' },
      isDefault: true,
    })
    .returning({ id: addresses.id });

  return { id: address!.id };
}

export async function customerProfileIdFor(userId: string): Promise<string> {
  const [row] = await getDb().select({ id: customerProfiles.id }).from(customerProfiles).where(eq(customerProfiles.userId, userId));
  return row!.id;
}

/** A registered customer with a saved address — the minimum a valid request needs. */
export async function registerCustomerWithAddress(): Promise<TestSession & { addressId: string }> {
  const session = await registerAndLogin();
  const address = await seedAddress(session.userId);
  return { ...session, addressId: address.id };
}

/** A `POST /api/v1/requests` request carrying the session, CSRF and `Idempotency-Key` headers. */
export function createRequestHttp(session: TestSession, idempotencyKey: string, body: unknown): Request {
  return new Request('http://localhost/api/v1/requests', {
    method: 'POST',
    headers: {
      cookie: `apuriva_session=${session.sessionId}`,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

export function validRequestBody(
  service: TestService,
  addressId: string,
  overrides?: Partial<CreateRequestRequest>,
): Partial<CreateRequestRequest> {
  return {
    serviceId: service.id,
    description: 'The kitchen tap has been dripping for two days.',
    fieldValues: { [service.requiredTextKey]: 'Dripping tap' },
    addressId,
    urgency: 'normal',
    ...overrides,
  };
}
