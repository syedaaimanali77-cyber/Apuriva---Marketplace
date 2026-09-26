/**
 * Spec 039 §3.7 (AC-4, D-2) — who may read which audit entries.
 *
 * `audit_logs/read` (seeded by 0034 for all seven roles) only OPENS the log. An entry is visible
 * when the viewer holds that permission AND either is `super_admin`, or holds the READ-LEVEL
 * permission this map names for the entry's `resource`.
 *
 * A read-level permission — not "any permission on the resource" — is required on purpose:
 * finance_admin holds `moderation/freeze_payout` but deliberately lacks `moderation/read` (spec 038
 * §3.9 least privilege), so it must not see moderation reasons through the audit log.
 *
 * DEFAULT DENY: `admin_rbac.role`, `mcp` and every resource missing from this map are visible to
 * super_admin only. A new audited resource stays invisible to its domain admins until it is mapped
 * here (`scope.test.ts` fails when an audited resource is unmapped).
 *
 * Every check reads role/permission state fresh through spec 009's tables; nothing is cached.
 */
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { permissions, roles } from '@/lib/db/schema';
import { forbiddenError } from '@/lib/api/errors';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';

export const AUDIT_READ_PERMISSION = { resource: 'audit_logs', action: 'read' } as const;

/** Entry `resource` → the read-level `(resource, action)` permission that makes it visible. */
export const AUDIT_RESOURCE_READ_PERMISSION: Readonly<Record<string, { resource: string; action: string }>> = {
  cancellation_policy: { resource: 'cancellation_policy', action: 'read' },
  'catalog.category': { resource: 'catalog.category', action: 'view' },
  'catalog.subcategory': { resource: 'catalog.subcategory', action: 'view' },
  'catalog.service': { resource: 'catalog.service', action: 'view' },
  'catalog.service_faq': { resource: 'catalog.service', action: 'view' },
  'catalog.service_field': { resource: 'catalog.service', action: 'view' },
  'catalog.suggestion': { resource: 'catalog.suggestion', action: 'view' },
  disputes: { resource: 'disputes', action: 'read' },
  // Spec 038's audit events take their resource from the event-type prefix (`fraud_signal.*`).
  fraud_signal: { resource: 'fraud_signals', action: 'read' },
  'matching.config': { resource: 'matching.config', action: 'read' },
  messaging: { resource: 'messaging', action: 'read_conversation' },
  moderation: { resource: 'moderation', action: 'read' },
  no_show_reports: { resource: 'no_show_reports', action: 'read' },
  payouts: { resource: 'payouts', action: 'read' },
  refunds: { resource: 'refunds', action: 'read' },
  reviews: { resource: 'reviews', action: 'read_moderation_queue' },
  safety_reports: { resource: 'safety_reports', action: 'read' },
  support: { resource: 'support', action: 'read' },
};

/** What a viewer may see: everything (`all`), or entries whose `resource` is in `resources`. */
export interface AuditScope {
  all: boolean;
  resources: string[];
}

/**
 * Resolves the caller's audit scope, or throws `403 FORBIDDEN` when the caller is not an admin or
 * does not hold `audit_logs/read`.
 */
export async function resolveAuditScope(userId: string): Promise<AuditScope> {
  const roleNames = await getAdminRoleNames(userId);
  if (roleNames.length === 0) throw forbiddenError('The audit log is for APURIVA administrators.');

  const held = await getDb()
    .select({ resource: permissions.resource, action: permissions.action })
    .from(permissions)
    .innerJoin(roles, eq(permissions.roleId, roles.id))
    .where(inArray(roles.name, roleNames));
  const heldKeys = new Set(held.map((p) => `${p.resource}/${p.action}`));

  if (!heldKeys.has(`${AUDIT_READ_PERMISSION.resource}/${AUDIT_READ_PERMISSION.action}`)) {
    throw forbiddenError('You do not have access to the audit log.');
  }
  if (roleNames.includes('super_admin')) return { all: true, resources: [] };

  const resources = Object.entries(AUDIT_RESOURCE_READ_PERMISSION)
    .filter(([, required]) => heldKeys.has(`${required.resource}/${required.action}`))
    .map(([entryResource]) => entryResource)
    .sort();
  return { all: false, resources };
}

/** Whether an entry with `resource` falls inside `scope`. */
export function isResourceInScope(scope: AuditScope, resource: string): boolean {
  return scope.all || scope.resources.includes(resource);
}
