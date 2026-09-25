/**
 * Spec 037 §3 "Endpoints" — the two authorization questions the dashboard asks, answered only
 * through spec 009's existing server-side resolution (`lib/admin-rbac/permissions.ts`). No role or
 * permission is introduced here (D-1): every check below names a permission another spec seeded.
 */
import { forbiddenError } from '@/lib/api/errors';
import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import type { AdminRole } from '@/lib/types/admin-rbac';

/**
 * AC-6 — the Overview and the queue are open to a caller holding ANY of the seven spec 009 roles,
 * and to no one else. A user with no admin profile, or a profile with zero roles, is refused alike.
 */
export async function requireAnyAdminRole(userId: string): Promise<AdminRole[]> {
  const roles = await getAdminRoleNames(userId);
  if (roles.length === 0) throw forbiddenError('This area is for APURIVA administrators.');
  return roles;
}

/** One existing `(resource, action)` permission, resolved fresh (spec 009 §3.1 — never cached). */
export async function holdsPermission(userId: string, resource: string, action: string): Promise<boolean> {
  return (await resolvePermission(userId, resource, action)).allowed;
}
