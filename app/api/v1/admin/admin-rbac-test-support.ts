import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, adminRoleAssignments, permissions, roles } from '@/lib/db/schema';
import type { AdminRole, RiskTier } from '@/lib/types/admin-rbac';
import { registerAndLogin, type TestSession } from '../users/me/privacy-test-support';

export { isDatabaseReachable, authenticatedRequest, uniqueEmail } from '@/app/api/v1/auth/test-support';
export type { TestSession } from '../users/me/privacy-test-support';

export interface TestAdmin extends TestSession {
  adminProfileId: string;
}

/** A fresh account, logged in, promoted to an `AdminProfile` directly at the DB layer (there is no
 * "become an admin" endpoint — spec 005 §4/§8 risk #2 only covers TOTP-MFA columns on a profile
 * that already exists, mirroring the pattern `app/api/v1/users/me/mfa/mfa.integration.test.ts`
 * already uses). Holds no roles yet. */
export async function registerAdmin(): Promise<TestAdmin> {
  const session = await registerAndLogin();
  const [row] = await getDb().insert(adminProfiles).values({ userId: session.userId }).returning({ id: adminProfiles.id });
  return { ...session, adminProfileId: row!.id };
}

/** Test-setup shortcut: assigns a role directly at the DB layer, bypassing the
 * Super-Admin-only `POST /admin/users/{userId}/roles` endpoint (used for bootstrapping a test's
 * fixture state; the endpoint itself is exercised separately by the role-assignment tests). */
export async function grantRole(admin: TestAdmin, role: AdminRole): Promise<void> {
  const [roleRow] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, role));
  if (!roleRow) throw new Error(`Role not seeded: ${role}`);
  await getDb().insert(adminRoleAssignments).values({ adminProfileId: admin.adminProfileId, roleId: roleRow.id }).onConflictDoNothing();
}

/** Test-setup shortcut standing in for a domain spec's own `Permission` seed (spec 009 §4.3:
 * this framework never seeds these itself). */
export async function seedPermission(role: AdminRole, resource: string, action: string, riskTier: RiskTier): Promise<void> {
  const [roleRow] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, role));
  if (!roleRow) throw new Error(`Role not seeded: ${role}`);
  await getDb()
    .insert(permissions)
    .values({ roleId: roleRow.id, resource, action, riskTier })
    .onConflictDoNothing();
}

/** Test-isolation helper: `revokeRole`'s LAST_SUPER_ADMIN guard counts `super_admin` holders
 * *globally* (spec 009 AC-5 is a platform-wide invariant, not scoped to one test's fixtures) — a
 * test asserting "the last one is blocked" needs a known, controlled starting count. Deletes
 * every existing `super_admin` assignment directly at the DB layer (safe here: this integration
 * suite runs single-file-sequential per vitest's default, and no other spec 009 test file touches
 * `super_admin`). */
export async function clearAllSuperAdmins(): Promise<void> {
  const [roleRow] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, 'super_admin'));
  if (!roleRow) return;
  await getDb().delete(adminRoleAssignments).where(eq(adminRoleAssignments.roleId, roleRow.id));
}

/** Convenience: a fresh admin already granted `role` and the matching `Permission`. */
export async function registerAdminWithPermission(
  role: AdminRole,
  resource: string,
  action: string,
  riskTier: RiskTier,
): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, role);
  await seedPermission(role, resource, action, riskTier);
  return admin;
}
