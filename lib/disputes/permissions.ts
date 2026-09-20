/**
 * Spec 031 §3 "Resolution ownership and authorization" (DECIDED-2) — the admin permission boundary.
 *
 * Three permissions, seeded by `drizzle/0028_add_disputes_resolution.sql`. The role split is not a
 * judgement call: master §69 assigns "Reports, **disputes**, safety" to the Trust & Safety Admin
 * and "Requests, bookings, providers" to the Operations Admin. Disputes appear in one line and not
 * the other, so Trust & Safety decides and Operations watches.
 *
 *   disputes/read          low     operations_admin, trust_safety_admin, super_admin
 *   disputes/resolve       medium  trust_safety_admin, super_admin
 *   disputes/review_appeal medium  trust_safety_admin, super_admin
 *
 * `finance_admin` is deliberately absent. Finance sees the refund request through spec 022's own
 * `refunds/read`, which already carries the amount, the reason and the approval chain; it does not
 * need the evidence or the parties' private messages to authorize money.
 *
 * NOTE WHAT IS NOT HERE. Every permission is `low`/`medium`, so this spec **never calls
 * `authorizeAndInitiate()`** — it initiates no approval-bearing action. Resolving a dispute moves
 * no money; the money it may PROPOSE travels through spec 022's `refunds/override` at tier `high`,
 * which already carries second-admin approval. Layering a second four-eyes flow on top would gate
 * the same decision twice. `lib/disputes/no-money-leak.test.ts` asserts the absence at source level.
 */
import { forbiddenError } from '@/lib/api/errors';
import { resolvePermission } from '@/lib/admin-rbac/permissions';

export const DISPUTES_RESOURCE = 'disputes';
export const DISPUTES_READ_ACTION = 'read';
export const DISPUTES_RESOLVE_ACTION = 'resolve';
export const DISPUTES_REVIEW_APPEAL_ACTION = 'review_appeal';

/** Queue access, dispute detail, the thread AND evidence reads. Reading is not deciding — but it is audited. */
export async function requireDisputeReadPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, DISPUTES_RESOURCE, DISPUTES_READ_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to view disputes.');
}

/** Claiming, resolving, linking a refund proposal, legal hold and safety escalation. Never a sanction. */
export async function requireDisputeResolvePermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, DISPUTES_RESOURCE, DISPUTES_RESOLVE_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to resolve disputes.');
}

/** Deciding an appeal. Held separately so an appeal reviewer can be a distinct, auditable grant. */
export async function requireDisputeReviewAppealPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, DISPUTES_RESOURCE, DISPUTES_REVIEW_APPEAL_ACTION);
  if (!permission.allowed) throw forbiddenError('You do not have permission to decide dispute appeals.');
}

/** Non-throwing form, for the evidence policy's `canRead`, which returns a boolean. */
export async function hasDisputeReadPermission(adminUserId: string): Promise<boolean> {
  const permission = await resolvePermission(adminUserId, DISPUTES_RESOURCE, DISPUTES_READ_ACTION);
  return permission.allowed;
}
