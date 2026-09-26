/**
 * Spec 038 §3.9 — permission checks on spec 009's existing model. Always server-side (spec 009 §5);
 * the UI may hide a button but is never authoritative. Nothing here decides a risk tier: spec 009's
 * `resolvePermission` reads the seeded `permissions` rows (migration 0033).
 */
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import type { ModerationActionType } from '@/lib/types/moderation';
import { adminForbiddenError } from './errors';
import { FRAUD_SIGNALS_RESOURCE, MODERATION_RESOURCE, PERMISSION_ACTION_FOR } from './catalogue';

export async function requireModerationPermission(adminUserId: string, action: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, MODERATION_RESOURCE, action);
  if (!permission.allowed) throw adminForbiddenError();
}

export async function hasModerationPermission(adminUserId: string, action: string): Promise<boolean> {
  return (await resolvePermission(adminUserId, MODERATION_RESOURCE, action)).allowed;
}

/** The per-type permission an action is initiated, approved and executed under. */
export async function requireActionTypePermission(adminUserId: string, actionType: ModerationActionType): Promise<void> {
  await requireModerationPermission(adminUserId, PERMISSION_ACTION_FOR[actionType]);
}

export async function requireFraudSignalPermission(adminUserId: string, action: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, FRAUD_SIGNALS_RESOURCE, action);
  if (!permission.allowed) throw adminForbiddenError();
}
