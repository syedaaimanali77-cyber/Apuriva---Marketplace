/**
 * Spec 030 §3 "Trust & Safety access" (AC-3) — the admin permission boundary.
 *
 * Three permissions, seeded by `drizzle/0027_add_blocking_safety_incidents.sql` for exactly two
 * roles: Trust & Safety and Super Admin. `support_admin` is deliberately excluded — master §64
 * requires restricted access, and support already reaches conversations through spec 025's
 * `messaging/read_conversation`.
 *
 * NOTE WHAT IS NOT HERE (DECIDED-3). There is no `user_restrictions/apply`, and none of these three
 * changes an account's state. An admin holding all three can read, triage, escalate and close a
 * safety report, and nothing else. Applying a restriction is spec 038's action behind spec 038's
 * permission and approval tier.
 *
 * Consequently every permission here is `low`/`medium`, so this spec never calls
 * `authorizeAndInitiate()` — it initiates no approval-bearing action. `resolvePermission` is the
 * whole check, resolved server-side (spec 009 §5); the frontend may hide a link but is never
 * authoritative.
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const SAFETY_RESOURCE = 'safety_reports';
export const SAFETY_READ_ACTION = 'read';
export const SAFETY_ESCALATE_ACTION = 'escalate';
export const SAFETY_RESOLVE_ACTION = 'resolve';

/** Queue access, report detail, AND evidence reads. Reading is not enforcement — but it is audited. */
export async function requireSafetyReadPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SAFETY_RESOURCE, SAFETY_READ_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to view safety reports.');
}

export async function requireSafetyEscalatePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SAFETY_RESOURCE, SAFETY_ESCALATE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to escalate safety reports.');
}

/** Claiming, priority change and resolution. Never a sanction. */
export async function requireSafetyResolvePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SAFETY_RESOURCE, SAFETY_RESOLVE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to resolve safety reports.');
}

/** Non-throwing form, for the evidence policy's `canRead`, which returns a boolean. */
export async function hasSafetyReadPermission(adminUserId: string): Promise<boolean> {
  const permission = await resolvePermission(adminUserId, SAFETY_RESOURCE, SAFETY_READ_ACTION);
  return permission.allowed;
}
