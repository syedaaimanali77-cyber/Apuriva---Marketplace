import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { ADMIN_ROLES, adminProfiles, adminRoleAssignments, roles } from '@/lib/db/schema';
import { recordAdminAuditEvent } from './audit';
import { adminForbiddenError, invalidRoleError, lastSuperAdminError, roleNotAssignedError, unknownAdminError } from './errors';
import { getAdminRoleNames } from './permissions';
import type { AdminRole } from '@/lib/types/admin-rbac';

/** §3/AC-5: role assignment/revocation itself is permission-scoped, not universally available —
 * only Super Admin may perform it. Checked directly against the admin's assigned roles rather
 * than through `resolvePermission`'s generic `(resource, action)` table: this is spec 009's own
 * framework-bootstrap operation, not a business action a domain spec declares a `Permission` row
 * for (that table legitimately starts empty — §4.3). */
async function requireSuperAdmin(actorUserId: string): Promise<AdminRole[]> {
  const roleNames = await getAdminRoleNames(actorUserId);
  if (!roleNames.includes('super_admin')) {
    throw adminForbiddenError('Only Super Admin can manage role assignments.');
  }
  return roleNames;
}

function assertValidRole(role: unknown): asserts role is AdminRole {
  if (typeof role !== 'string' || !(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw invalidRoleError(role);
  }
}

async function getRoleId(role: AdminRole): Promise<string> {
  const [row] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, role));
  if (!row) throw invalidRoleError(role);
  return row.id;
}

/** Idempotent: an admin with no `AdminProfile` yet gets one created on first role assignment —
 * there is no separate "become an admin" flow anywhere else in the codebase (unlike
 * `CustomerProfile`/`ProviderProfile`, which spec 006 provisions on their own triggers), so
 * assigning a role is what an account's admin-hood is grounded in. */
async function getOrCreateAdminProfileId(targetUserId: string): Promise<string> {
  const [existing] = await getDb().select({ id: adminProfiles.id }).from(adminProfiles).where(eq(adminProfiles.userId, targetUserId));
  if (existing) return existing.id;

  const [created] = await getDb().insert(adminProfiles).values({ userId: targetUserId }).returning({ id: adminProfiles.id });
  return created!.id;
}

/** Spec 009 §3/AC-5, `POST /admin/users/{userId}/roles`. Idempotent: assigning a role the target
 * already holds is a no-op, not a conflict. */
export async function assignRole(actorUserId: string, targetUserId: string, role: unknown): Promise<AdminRole> {
  assertValidRole(role);
  const actorRoles = await requireSuperAdmin(actorUserId);

  const adminProfileId = await getOrCreateAdminProfileId(targetUserId);
  const roleId = await getRoleId(role);

  await getDb().insert(adminRoleAssignments).values({ adminProfileId, roleId }).onConflictDoNothing();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'admin_rbac.role_assigned',
    resource: 'admin_rbac.role',
    action: 'assign',
    targetType: 'admin_profile',
    targetId: adminProfileId,
    reason: `role=${role}`,
    approvalChain: [],
  });

  return role;
}

/**
 * Spec 009 §3/AC-5, `DELETE /admin/users/{userId}/roles/{role}`. Guards the `super_admin` case
 * specifically (§4.2/AC-5): the count of remaining `super_admin` holders is re-read inside the
 * same transaction that deletes the assignment, with `FOR UPDATE` on the matching
 * `admin_role_assignments` rows, so two concurrent revocations against the last two Super Admins
 * can't both read "2 remaining" and both proceed — one blocks until the other's transaction
 * commits, then re-reads the now-current count.
 */
export async function revokeRole(actorUserId: string, targetUserId: string, role: unknown): Promise<void> {
  assertValidRole(role);
  const actorRoles = await requireSuperAdmin(actorUserId);

  const [adminProfile] = await getDb().select({ id: adminProfiles.id }).from(adminProfiles).where(eq(adminProfiles.userId, targetUserId));
  if (!adminProfile) throw unknownAdminError();

  const roleId = await getRoleId(role);

  await getDb().transaction(async (tx) => {
    // Locks every assignment row for this role — for `super_admin` specifically, that's the
    // exact set a concurrent revocation of a *different* Super Admin would also need to lock,
    // which is what makes the count below race-free.
    const holders = await tx
      .select({ id: adminRoleAssignments.id, adminProfileId: adminRoleAssignments.adminProfileId })
      .from(adminRoleAssignments)
      .where(eq(adminRoleAssignments.roleId, roleId))
      .for('update');

    const target = holders.find((h) => h.adminProfileId === adminProfile.id);
    if (!target) throw roleNotAssignedError();
    if (role === 'super_admin' && holders.length <= 1) throw lastSuperAdminError();

    await tx.delete(adminRoleAssignments).where(eq(adminRoleAssignments.id, target.id));
  });

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'admin_rbac.role_revoked',
    resource: 'admin_rbac.role',
    action: 'revoke',
    targetType: 'admin_profile',
    targetId: adminProfile.id,
    reason: `role=${role}`,
    approvalChain: [],
  });
}
