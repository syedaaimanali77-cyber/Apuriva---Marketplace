import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { catalogForbiddenError } from './errors';

/**
 * Spec 010 §3: every `/api/v1/admin/**` catalog endpoint resolves a `(resource, action)`
 * permission check server-side through spec 009 §3.1's plain permission-resolution framework
 * (never `authorizeAndInitiate`'s risk-tiered approval branch — this spec defines no approval
 * workflow of its own). Returns the actor's current roles for the caller to pass straight into
 * `recordAdminAuditEvent` (spec 009 AC-4: every audit event carries the actor's role(s)).
 */
export async function requireCatalogPermission(userId: string, resource: string, action: string): Promise<AdminRole[]> {
  const perm = await resolvePermission(userId, resource, action);
  if (!perm.allowed) throw catalogForbiddenError();
  return getAdminRoleNames(userId);
}
