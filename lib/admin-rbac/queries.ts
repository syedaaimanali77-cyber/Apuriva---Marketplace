import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminActions, adminProfiles, permissions, roles } from '@/lib/db/schema';
import { getAdminRoleNames } from './permissions';
import type { PageParams } from '@/lib/api/pagination';
import type { PendingApprovalDto, PendingReviewDto, RiskTier } from '@/lib/types/admin-rbac';

/** Every `(resource, action)` pair any of `userId`'s currently assigned roles grants — the scope
 * "pending approvals"/"pending review" lists are filtered to (§5 UI states: "role-gated ... hidden
 * for out-of-scope actions"). */
async function scopedResourceActionKeys(userId: string): Promise<Set<string>> {
  const roleNames = await getAdminRoleNames(userId);
  if (roleNames.length === 0) return new Set();

  const rows = await getDb()
    .select({ resource: permissions.resource, action: permissions.action })
    .from(permissions)
    .innerJoin(roles, eq(permissions.roleId, roles.id))
    .where(inArray(roles.name, roleNames));

  return new Set(rows.map((r) => `${r.resource}::${r.action}`));
}

/**
 * Spec 009 §3, `GET /admin/approvals/pending` — every `Pending` `AdminAction` the caller is
 * authorized to decide. Filters/paginates in application code rather than a tuple-`IN` SQL clause:
 * this is a small, framework-internal list (pending high/critical actions across the whole admin
 * surface), not a high-volume domain query.
 */
export async function listPendingApprovals(userId: string, page: PageParams): Promise<{ items: PendingApprovalDto[]; total: number }> {
  const scopedKeys = await scopedResourceActionKeys(userId);
  if (scopedKeys.size === 0) return { items: [], total: 0 };

  const rows = await getDb()
    .select({
      id: adminActions.id,
      resource: adminActions.resource,
      actionType: adminActions.actionType,
      riskTier: adminActions.riskTier,
      createdAt: adminActions.createdAt,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      reason: adminActions.reason,
      initiatedByUserId: adminProfiles.userId,
    })
    .from(adminActions)
    .innerJoin(adminProfiles, eq(adminActions.adminId, adminProfiles.id))
    .where(eq(adminActions.status, 'Pending'))
    .orderBy(desc(adminActions.createdAt));

  const filtered = rows.filter((r) => scopedKeys.has(`${r.resource}::${r.actionType}`));
  const paged = filtered.slice(page.offset, page.offset + page.limit);

  const items: PendingApprovalDto[] = paged.map((r) => ({
    id: r.id,
    resource: r.resource,
    actionType: r.actionType,
    riskTier: r.riskTier as RiskTier,
    initiatedBy: r.initiatedByUserId,
    initiatedAt: r.createdAt.toISOString(),
    targetSummary: `${r.targetType}:${r.targetId}`,
    reason: r.reason,
  }));
  return { items, total: filtered.length };
}

/** Spec 009 §3.2/AC-3, `GET /admin/actions/pending-review` — every `AdminAction` awaiting
 * mandatory post-action review, scoped the same way as `listPendingApprovals`. */
export async function listPendingReviews(userId: string, page: PageParams): Promise<{ items: PendingReviewDto[]; total: number }> {
  const scopedKeys = await scopedResourceActionKeys(userId);
  if (scopedKeys.size === 0) return { items: [], total: 0 };

  const rows = await getDb()
    .select({
      id: adminActions.id,
      resource: adminActions.resource,
      actionType: adminActions.actionType,
      createdAt: adminActions.createdAt,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      reason: adminActions.reason,
      initiatedByUserId: adminProfiles.userId,
    })
    .from(adminActions)
    .innerJoin(adminProfiles, eq(adminActions.adminId, adminProfiles.id))
    .where(eq(adminActions.status, 'PostActionReviewRequired'))
    .orderBy(desc(adminActions.createdAt));

  const filtered = rows.filter((r) => scopedKeys.has(`${r.resource}::${r.actionType}`));
  const paged = filtered.slice(page.offset, page.offset + page.limit);

  const items: PendingReviewDto[] = paged.map((r) => ({
    id: r.id,
    resource: r.resource,
    actionType: r.actionType,
    initiatedBy: r.initiatedByUserId,
    // The bypass path creates the row already-executed (lib/admin-rbac/actions.ts
    // `authorizeAndInitiate`) — its creation IS the execution moment.
    executedAt: r.createdAt.toISOString(),
    targetSummary: `${r.targetType}:${r.targetId}`,
    reason: r.reason,
    isEmergencyBypass: true,
  }));
  return { items, total: filtered.length };
}
