/**
 * Spec 032 §3 "Admin RBAC" (DECIDED-9) — the admin permission boundary.
 *
 * Five permissions, seeded by `drizzle/0029_add_customer_provider_support.sql`. The role split is
 * not a judgement call: master §69 assigns "Support tickets and user support" to the **Support
 * Admin** by name, and assigns "Requests, bookings, providers" to the Operations Admin.
 *
 *   support/read     low     support_admin, operations_admin, super_admin
 *   support/assign   low     support_admin, super_admin
 *   support/respond  low     support_admin, super_admin
 *   support/triage   medium  support_admin, super_admin
 *   support/resolve  medium  support_admin, super_admin
 *
 * `operations_admin` reads and nothing more. The workspace lives under the Operations nav item, so
 * Operations can WATCH the queue it navigates to — spec 031's `disputes/read` reasoning exactly —
 * but master gives the decisions to Support.
 *
 * `trust_safety_admin` and `finance_admin` are deliberately absent. A handed-off ticket reaches
 * them through THEIR OWN queue (spec 030's `safety_reports`, spec 031's `disputes`, spec 022's
 * refund chain), each already carrying the full context, the reason and — for money — the
 * four-eyes approval. A second window onto the same matter would duplicate exposure without adding
 * capability.
 *
 * NOTE WHAT IS NOT HERE. Every permission is `low`/`medium`, so this spec **never calls
 * `authorizeAndInitiate()`** — no support action is consequential. There is also no
 * "view sensitive payment/dispute/safety context" permission, because there is no sensitive
 * context to gate: the workspace projects pointers and neutral statuses only (DECIDED-6), and the
 * detail is read through the owning spec's own permissioned routes.
 * `lib/support/no-consequential-action.test.ts` asserts the absence at source level.
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const SUPPORT_RESOURCE = 'support';
export const SUPPORT_READ_ACTION = 'read';
export const SUPPORT_ASSIGN_ACTION = 'assign';
export const SUPPORT_RESPOND_ACTION = 'respond';
export const SUPPORT_TRIAGE_ACTION = 'triage';
export const SUPPORT_RESOLVE_ACTION = 'resolve';

/** Queue access, ticket detail, the thread, the internal notes AND attachment reads. Audited. */
export async function requireSupportReadPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SUPPORT_RESOURCE, SUPPORT_READ_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to view support tickets.');
}

/** Claiming, assigning and reassigning. */
export async function requireSupportAssignPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SUPPORT_RESOURCE, SUPPORT_ASSIGN_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to assign support tickets.');
}

/** Admin replies AND internal notes — one permission, because both are "speaking on the ticket". */
export async function requireSupportRespondPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SUPPORT_RESOURCE, SUPPORT_RESPOND_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to reply to support tickets.');
}

/** Priority change. `medium` rather than `low` because it recomputes the SLA deadline. */
export async function requireSupportTriagePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SUPPORT_RESOURCE, SUPPORT_TRIAGE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to change support ticket priority.');
}

/** Resolve, hand off, admin reopen and admin close. Never a sanction, never a refund. */
export async function requireSupportResolvePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, SUPPORT_RESOURCE, SUPPORT_RESOLVE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to resolve support tickets.');
}

/** Non-throwing form, for the attachment policy's `canRead`, which returns a boolean. */
export async function hasSupportReadPermission(userId: string): Promise<boolean> {
  const permission = await resolvePermission(userId, SUPPORT_RESOURCE, SUPPORT_READ_ACTION);
  return permission.allowed;
}

/** Non-throwing form, used to check an assignment TARGET is eligible before assigning to them. */
export async function hasSupportRespondPermission(userId: string): Promise<boolean> {
  const permission = await resolvePermission(userId, SUPPORT_RESOURCE, SUPPORT_RESPOND_ACTION);
  return permission.allowed;
}
