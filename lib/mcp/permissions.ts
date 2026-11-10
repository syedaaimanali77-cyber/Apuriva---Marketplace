/**
 * Spec 035 §3 check 7 and the admin registry route's own guard — both go through spec 009's
 * resolver (`lib/admin-rbac/permissions.ts`). There is no second permission model here: this
 * module only names the permissions this spec introduces and asks spec 009 whether they are held.
 *
 * `('mcp', 'read_registry')` is seeded by this spec's migration for Super Admin only. The registry
 * lists every tool, its risk tier and whether it can be undone — a map of what the assistant is
 * able to do, which is platform-security information rather than day-to-day admin work.
 */
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';

export const MCP_RESOURCE = 'mcp';
export const MCP_READ_REGISTRY_ACTION = 'read_registry';

/** Check 7: does any role assigned to this user grant the tool's `(resource, action)`? */
export async function resolveMcpToolPermission(
  userId: string,
  permission: { resource: string; action: string },
): Promise<boolean> {
  const resolved = await resolvePermission(userId, permission.resource, permission.action);
  return resolved.allowed;
}

/** Route guard for `GET /api/v1/admin/mcp/tools`, mirroring spec 033's `requireAiUsagePermission`. */
export async function requireMcpRegistryPermission(userId: string): Promise<void> {
  const resolved = await resolvePermission(userId, MCP_RESOURCE, MCP_READ_REGISTRY_ACTION);
  if (!resolved.allowed) throw adminForbiddenError();
}
