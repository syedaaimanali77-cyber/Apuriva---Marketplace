/**
 * Spec 033 §4/AC-6 — the admin permission boundary for AI usage. `('ai', 'read_usage')` is seeded
 * by `drizzle/0025_add_ai_usage_tracking.sql` for exactly three roles (Analytics, Finance and
 * Super Admin); every other admin role therefore cannot read AI usage. Resolution is always
 * server-side (spec 009 §5) — the frontend may hide the link but is never authoritative.
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const AI_RESOURCE = 'ai';
export const AI_READ_USAGE_ACTION = 'read_usage';

export async function requireAiUsagePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, AI_RESOURCE, AI_READ_USAGE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to view AI usage.');
}
