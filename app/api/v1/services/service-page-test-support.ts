import { getDb } from '@/lib/db';
import { providerProfiles, providerServices } from '@/lib/db/schema';
import { grantRole, registerAdmin, seedPermission, type TestAdmin } from '../admin/admin-rbac-test-support';
import { registerAndLogin, type TestSession } from '../users/me/privacy-test-support';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';
export { registerAdmin, grantRole } from '../admin/admin-rbac-test-support';
export type { TestAdmin } from '../admin/admin-rbac-test-support';

const SERVICE_PAGE_PERMISSIONS: [string, string][] = [
  ['catalog.service_field', 'create'],
  ['catalog.service_faq', 'create'],
  ['catalog.service_faq', 'approve'],
];

/** A fresh admin, granted `content_admin` and every spec 011 permission (field create, FAQ
 * create, FAQ approve). Mirrors `app/api/v1/catalog/catalog-test-support.ts`'s
 * `registerContentAdmin`, extended with this spec's own resources. */
export async function registerServicePageAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'content_admin');
  for (const [resource, action] of SERVICE_PAGE_PERMISSIONS) {
    await seedPermission('content_admin', resource, action, 'low');
  }
  return admin;
}

export interface TestProvider extends TestSession {
  providerProfileId: string;
}

/** A fresh account, logged in, with a `ProviderProfile` linked to `serviceId` via
 * `provider_services` — the exact ownership check `createProviderFaq` (spec 011 §3) requires. */
export async function registerProviderOffering(serviceId: string): Promise<TestProvider> {
  const session = await registerAndLogin();
  const [profile] = await getDb().insert(providerProfiles).values({ userId: session.userId }).returning({ id: providerProfiles.id });
  await getDb().insert(providerServices).values({ providerProfileId: profile!.id, serviceId }).onConflictDoNothing();
  return { ...session, providerProfileId: profile!.id };
}

/** A fresh provider account with NO offering for `serviceId` — the negative-ownership case. */
export async function registerProviderNotOffering(): Promise<TestProvider> {
  const session = await registerAndLogin();
  const [profile] = await getDb().insert(providerProfiles).values({ userId: session.userId }).returning({ id: providerProfiles.id });
  return { ...session, providerProfileId: profile!.id };
}
