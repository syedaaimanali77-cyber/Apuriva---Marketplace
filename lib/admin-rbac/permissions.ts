import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, adminRoleAssignments, permissions, roles } from '@/lib/db/schema';
import type { AdminRole, RiskTier } from '@/lib/types/admin-rbac';

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The most severe of a set of risk tiers — used when more than one of the admin's roles grants
 * the same `(resource, action)`, so a broader role can never quietly downgrade what a narrower
 * one would have required. */
function maxTier(tiers: RiskTier[]): RiskTier {
  return tiers.reduce((max, tier) => (TIER_RANK[tier] > TIER_RANK[max] ? tier : max));
}

export async function getAdminProfileId(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: adminProfiles.id }).from(adminProfiles).where(eq(adminProfiles.userId, userId));
  return row?.id ?? null;
}

/** Every `AdminRole` currently assigned to `userId`, via `admin_role_assignments`. Empty for a
 * user with no `AdminProfile` or no role assignments — never throws for that case, since "not an
 * admin" and "admin with zero roles" both simply resolve no permissions. */
export async function getAdminRoleNames(userId: string): Promise<AdminRole[]> {
  const rows = await getDb()
    .select({ name: roles.name })
    .from(adminRoleAssignments)
    .innerJoin(adminProfiles, eq(adminRoleAssignments.adminProfileId, adminProfiles.id))
    .innerJoin(roles, eq(adminRoleAssignments.roleId, roles.id))
    .where(eq(adminProfiles.userId, userId));
  return rows.map((r) => r.name as AdminRole);
}

export interface ResolvedPermission {
  allowed: boolean;
  riskTier: RiskTier | null;
}

/**
 * Spec 009 §3.1 step 1/§5: resolves whether `userId` holds a `Permission` matching
 * `(resource, action)` through ANY of their currently assigned roles, and the declared risk tier.
 * Always server-side — the frontend may hide menu items for out-of-scope actions but is never
 * authoritative (§5). Reads role/permission state fresh on every call, so a role change becomes
 * effective for the next authorization check via whatever session/cache invalidation the app
 * already uses (§3.1) — this function itself does no caching of its own.
 */
export async function resolvePermission(userId: string, resource: string, action: string): Promise<ResolvedPermission> {
  const roleNames = await getAdminRoleNames(userId);
  if (roleNames.length === 0) return { allowed: false, riskTier: null };

  const rows = await getDb()
    .select({ riskTier: permissions.riskTier })
    .from(permissions)
    .innerJoin(roles, eq(permissions.roleId, roles.id))
    .where(and(inArray(roles.name, roleNames), eq(permissions.resource, resource), eq(permissions.action, action)));

  if (rows.length === 0) return { allowed: false, riskTier: null };

  return { allowed: true, riskTier: maxTier(rows.map((r) => r.riskTier as RiskTier)) };
}
