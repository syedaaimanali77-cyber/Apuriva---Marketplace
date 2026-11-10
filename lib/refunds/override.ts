/**
 * Spec 022 §3 "Admin override" (AC-3) — the Finance Admin path, built entirely on spec 009.
 *
 * THE THRESHOLD QUESTION, RESOLVED: spec 009's risk tier is a column on `permissions` keyed by
 * `(role, resource, action)` — it has no amount dimension, so an amount-based threshold would have
 * meant inventing a mechanism spec 009 does not have. Migration `0018` instead seeds
 * `refunds/override` at tier **`high`**, so EVERY manual refund routes through the second-admin
 * approval flow and there is no number to define or probe. Master spec §70 lists "Large refund" as
 * potentially sensitive and mandates no numeric threshold.
 *
 * This module implements NO approval logic of its own. `authorizeAndInitiate`, `decideAction` and
 * `executeApprovedAction` are spec 009's, and so is every audit record they write — including the
 * "different admin" rule (`SELF_APPROVAL_NOT_ALLOWED`) and the conditional
 * `UPDATE ... WHERE status = 'Pending'` that makes concurrent decisions safe.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminActions } from '@/lib/db/schema';
import { authorizeAndInitiate, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import type { RefundDto, RefundOverrideDto } from '@/lib/types/refunds';
import {
  adminForbiddenError,
  approvalNotEligibleError,
  approvalRequiredError,
  refundAmountInvalidError,
  refundNotFoundError,
} from './errors';
import { executeApprovedRefund } from './execute';
import { emitRefundNotification } from './notifications';
import { isValidCurrencyCode, isValidRefundAmount } from './amounts';

/** The `(resource, action)` pair migration 0018 seeds at risk tier `high`. */
export const REFUND_OVERRIDE_RESOURCE = 'refunds';
export const REFUND_OVERRIDE_ACTION = 'override';
export const REFUND_READ_ACTION = 'read';

export interface InitiateRefundOverrideInput {
  adminUserId: string;
  bookingId: string;
  amountMinorUnits: number;
  currencyCode: string;
  reason: string;
  idempotencyKey: string;
}

export type InitiateRefundOverrideResult = { outcome: 'pending_approval'; override: RefundOverrideDto };

/**
 * AC-3 — initiates an override.
 *
 * With `refunds/override` seeded at `high`, spec 009 always returns `pending_approval`, so **no
 * refund row is created and no provider call is made** at this point. Every other outcome is
 * refused (see the comment at the end of this function) rather than treated as permission to move
 * money, so a misconfigured seed fails closed instead of silently disabling AC-3's four eyes.
 */
export async function initiateRefundOverride(
  input: InitiateRefundOverrideInput,
): Promise<InitiateRefundOverrideResult> {
  if (!isValidRefundAmount(input.amountMinorUnits)) {
    throw refundAmountInvalidError('must be a positive integer number of minor units');
  }
  if (!isValidCurrencyCode(input.currencyCode)) {
    throw refundAmountInvalidError('currencyCode must be a three-letter ISO-4217 code');
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    // Master spec §68 — an admin action always carries a reason.
    throw refundAmountInvalidError('reason is required');
  }

  const initiated = await authorizeAndInitiate({
    userId: input.adminUserId,
    resource: REFUND_OVERRIDE_RESOURCE,
    action: REFUND_OVERRIDE_ACTION,
    targetType: 'booking',
    targetId: input.bookingId,
    reason: input.reason.trim(),
    // Never requested by this spec: a refund is not an emergency that justifies bypassing review.
  });

  if (initiated.outcome === 'pending_approval') {
    await emitRefundNotification({ kind: 'refund_approval_required', adminActionId: initiated.adminActionId });
    return {
      outcome: 'pending_approval',
      override: {
        adminActionId: initiated.adminActionId,
        status: 'pending_approval',
        bookingId: input.bookingId,
        amountMinorUnits: input.amountMinorUnits,
        currencyCode: input.currencyCode,
      },
    };
  }

  /*
   * Neither remaining outcome may move money.
   *
   * `permitted` means the risk tier was lowered below `high`, and `emergency_bypass_executed` means
   * someone asked for a bypass this spec never requests. Both are refused rather than honoured:
   * C-5 requires every override to carry a real `admin_action_id` from a real approval chain, and
   * spec 009's `AdminAction.risk_tier` only admits `high`/`critical`, so there is no honest row to
   * write for a low/medium refund override. Failing closed here means a misconfigured seed cannot
   * quietly turn AC-3's four-eyes requirement off.
   */
  throw approvalRequiredError();
}

export interface ExecuteRefundOverrideInput {
  adminUserId: string;
  adminActionId: string;
  amountMinorUnits: number;
  currencyCode: string;
  idempotencyKey: string;
}

/**
 * AC-3 — executes an override whose `AdminAction` a second admin has APPROVED.
 *
 * `executeApprovedAction` is spec 009's and is what enforces the gate: a still-`Pending` action
 * surfaces `422 APPROVAL_REQUIRED`, and a `Rejected`/already-`Executed` one surfaces
 * `409 APPROVAL_NOT_ELIGIBLE`. This module never inspects or overrides that decision itself.
 */
export async function executeRefundOverride(input: ExecuteRefundOverrideInput): Promise<RefundDto> {
  const permission = await resolvePermission(input.adminUserId, REFUND_OVERRIDE_RESOURCE, REFUND_OVERRIDE_ACTION);
  if (!permission.allowed) throw adminForbiddenError();

  const [action] = await getDb()
    .select({
      id: adminActions.id,
      targetId: adminActions.targetId,
      targetType: adminActions.targetType,
      reason: adminActions.reason,
      status: adminActions.status,
    })
    .from(adminActions)
    .where(and(eq(adminActions.id, input.adminActionId), eq(adminActions.resource, REFUND_OVERRIDE_RESOURCE)));
  if (!action) throw refundNotFoundError();
  if (action.targetType !== 'booking') throw approvalNotEligibleError();

  // Spec 009 owns the whole decision. Throws 422 APPROVAL_REQUIRED while still Pending.
  await executeApprovedAction(input.adminActionId, input.adminUserId);

  const { refund } = await executeApprovedRefund({
    adminUserId: input.adminUserId,
    bookingId: action.targetId,
    amountMinorUnits: input.amountMinorUnits,
    currencyCode: input.currencyCode,
    reason: action.reason,
    adminActionId: input.adminActionId,
    idempotencyKey: input.idempotencyKey,
  });

  await emitRefundNotification({
    kind: 'refund_approval_decided',
    adminActionId: input.adminActionId,
    decision: 'approved',
  });
  return refund;
}

/** Whether an admin may read the refund surface (`refunds/read`, seeded `low`). */
export async function requireRefundReadPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, REFUND_OVERRIDE_RESOURCE, REFUND_READ_ACTION);
  if (!permission.allowed) throw adminForbiddenError();
}
