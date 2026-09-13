import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, requests } from '@/lib/db/schema';
import {
  allWeekAlwaysOpen,
  registerCustomer,
  registerProvider,
  seedAddressAt,
  seedProviderService,
  seedWeeklyHours,
  LAHORE,
  type ProviderFixture,
} from '@/app/api/v1/providers/availability-test-support';
import type { TestSession } from '@/app/api/v1/users/me/privacy-test-support';

export {
  allWeekAlwaysOpen,
  authenticatedRequest,
  isDatabaseReachable,
  LAHORE,
  LAHORE_NEARBY,
  ISLAMABAD,
  registerAndLogin,
  registerCustomer,
  registerProvider,
  seedAddressAt,
  seedForeignService,
  seedProviderService,
  seedWeeklyHours,
  sessionGet,
  sessionMutate,
  type ProviderFixture,
  type TestSession,
} from '@/app/api/v1/providers/availability-test-support';
export { registerAdmin, registerAdminWithPermission, grantRole } from '@/app/api/v1/admin/admin-rbac-test-support';

/**
 * Spec 017 §6 fixtures — a `submitted` request, written directly at the DB layer (the same
 * "test-setup shortcut" pattern every other domain's test-support module in this repo uses),
 * because these suites exercise MATCHING, not spec 015's `POST /requests` creation flow, which has
 * its own integration tests.
 */
export async function customerProfileIdFor(userId: string): Promise<string> {
  const [row] = await getDb().select({ id: customerProfiles.id }).from(customerProfiles).where(eq(customerProfiles.userId, userId));
  return row!.id;
}

export interface SeedRequestOptions {
  preferredAt?: Date | null;
  status?: string;
}

export async function seedSubmittedRequest(
  customerUserId: string,
  serviceId: string,
  addressId: string,
  options?: SeedRequestOptions,
): Promise<{ id: string }> {
  const customerProfileId = await customerProfileIdFor(customerUserId);
  const [row] = await getDb()
    .insert(requests)
    .values({
      customerProfileId,
      serviceId,
      addressId,
      status: (options?.status ?? 'submitted') as 'submitted',
      description: 'Test request for spec 017 matching.',
      urgency: 'normal',
      preferredAt: options?.preferredAt ?? null,
      preferredTimezone: options?.preferredAt ? 'Asia/Karachi' : null,
      idempotencyKey: `matching-test-${randomUUID()}`,
      idempotencyFingerprint: 'matching-test-fingerprint',
    })
    .returning({ id: requests.id });
  return { id: row!.id };
}

/** A registered, active, always-available provider offering `serviceId` — the common "definitely
 * eligible" shape most matching tests build on. */
export async function seedEligibleProvider(serviceId?: string): Promise<ProviderFixture & { serviceId: string }> {
  const provider = await registerProvider();
  const { serviceId: svc } = serviceId
    ? { serviceId }
    : await seedProviderService(provider.providerProfileId);
  await seedWeeklyHours(provider.providerProfileId, allWeekAlwaysOpen());
  return { ...provider, serviceId: svc };
}

/** A registered customer with an address near `LAHORE`. */
export async function seedCustomerWithAddress(): Promise<TestSession & { addressId: string }> {
  const customer = await registerCustomer();
  const { addressId } = await seedAddressAt(customer.userId, LAHORE);
  return { ...customer, addressId };
}
