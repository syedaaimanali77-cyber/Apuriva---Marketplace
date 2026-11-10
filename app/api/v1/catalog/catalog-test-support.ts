import { grantRole, registerAdmin, seedPermission, type TestAdmin } from '../admin/admin-rbac-test-support';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';
export { registerAdmin, grantRole } from '../admin/admin-rbac-test-support';
export type { TestAdmin } from '../admin/admin-rbac-test-support';

/** Spec 010 §3: the full `(resource, action)` set this spec's migration seeds for `content_admin`
 * — mirrored here for tests so a fresh admin fixture is authorized for every catalog operation
 * without depending on the actual migration having run against the test's connection. */
const CATALOG_PERMISSIONS: [string, string][] = [
  ['catalog.category', 'view'],
  ['catalog.category', 'create'],
  ['catalog.category', 'edit'],
  ['catalog.category', 'retire'],
  ['catalog.subcategory', 'view'],
  ['catalog.subcategory', 'create'],
  ['catalog.subcategory', 'edit'],
  ['catalog.subcategory', 'retire'],
  ['catalog.service', 'view'],
  ['catalog.service', 'create'],
  ['catalog.service', 'edit'],
  ['catalog.service', 'retire'],
  ['catalog.suggestion', 'view'],
  ['catalog.suggestion', 'approve'],
  ['catalog.suggestion', 'reject'],
];

/** A fresh admin, granted `content_admin` and every catalog `Permission` — the Content/Marketplace
 * admin fixture every catalog integration test needs. */
export async function registerContentAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'content_admin');
  for (const [resource, action] of CATALOG_PERMISSIONS) {
    await seedPermission('content_admin', resource, action, 'low');
  }
  return admin;
}
