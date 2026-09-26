/**
 * Spec 040 §3.7 — report authorization, decided server-side through spec 009's `resolvePermission`.
 * The three permissions are seeded by 0035 for the existing roles only (master §69).
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const ANALYTICS_RESOURCE = 'analytics';

export const ANALYTICS_ACTIONS = {
  /** funnel, supply/demand, retention, service trends — analytics_admin, super_admin */
  read: 'read',
  /** revenue — analytics_admin, finance_admin, super_admin */
  readRevenue: 'read_revenue',
  /** provider performance, matching fairness — analytics_admin, operations_admin, super_admin */
  readProviderPerformance: 'read_provider_performance',
} as const;

export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[keyof typeof ANALYTICS_ACTIONS];

/** `403 FORBIDDEN` unless the caller holds `analytics/<action>` through one of their roles. */
export async function requireAnalyticsPermission(userId: string, action: AnalyticsAction): Promise<void> {
  const permission = await resolvePermission(userId, ANALYTICS_RESOURCE, action);
  if (!permission.allowed) throw forbiddenError('You do not have access to this report.');
}
