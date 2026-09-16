/**
 * Spec 024 §3.8, §3.10, §3.14 — the Finance Admin surface, built entirely on spec 009.
 *
 * Both money-moving actions are seeded at risk tier `high` (`0020`), so `authorizeAndInitiate()`
 * always yields `pending_approval` and a SECOND, distinct admin must approve on spec 009's existing
 * approvals routes. Any other outcome FAILS CLOSED with `422 APPROVAL_REQUIRED` — the same guard
 * `lib/refunds/override.ts` implements — so a mis-seeded tier cannot quietly remove four-eyes.
 *
 * AMOUNT BINDING (§3.10): spec 009's `admin_actions` has no payload column, so an adjustment row is
 * written at INITIATION with immutable figures and targeted by the action. Execution accepts no
 * amount; it only sets `applied_at`. The applied figures are the approved figures by construction.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminActions } from '@/lib/db/schema';
import { validationError } from '@/lib/api/errors';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { authorizeAndInitiate, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import {
  isEarningsAdjustmentKind,
  type AdjustmentPendingDto,
  type AdminPayoutDto,
  type EarningsAdjustmentDto,
  type PayoutRetryPendingDto,
} from '@/lib/types/payouts';
import {
  adjustmentAmountInvalidError,
  adjustmentCurrencyMismatchError,
  adjustmentNotFoundError,
  adminForbiddenError,
  approvalNotEligibleError,
  approvalRequiredError,
  idempotencyKeyConflictError,
  payoutAlreadyPaidError,
  payoutAlreadyProcessingError,
  payoutNotFoundError,
  payoutNotRetryableError,
  payoutRetryAlreadyPendingError,
} from './errors';
import { availableCurrencies, loadAdjustmentRow, loadAdminPayoutDetail, toAdjustmentDto } from './read';
import { findUsableDefaultMethod } from './ledger';
import { reopenFailedPayout } from './transfer';

export const PAYOUTS_RESOURCE = 'payouts';
export const PAYOUTS_READ_ACTION = 'read';
export const PAYOUTS_RETRY_ACTION = 'retry';
export const PAYOUTS_ADJUST_ACTION = 'adjust';

const MAX_REASON_LENGTH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-id-bearing admin routes: a missing permission is `403`. */
export async function requirePayoutPermission(adminUserId: string, action: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, PAYOUTS_RESOURCE, action);
  if (!permission.allowed) throw adminForbiddenError();
}

/** Id-bearing admin routes: a missing permission is indistinguishable from a missing id (AC-13). */
export async function requirePayoutPermissionOrNotFound(adminUserId: string, action: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, PAYOUTS_RESOURCE, action);
  if (!permission.allowed) throw payoutNotFoundError();
}

function parseReason(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length === 0) throw validationError([{ field: 'reason', message: 'is required' }]);
  if (reason.length > MAX_REASON_LENGTH) throw validationError([{ field: 'reason', message: `must be at most ${MAX_REASON_LENGTH} characters` }]);
  return reason;
}

export type InitiateAdjustmentResult = { outcome: 'pending_approval'; pending: AdjustmentPendingDto; replayed: boolean };

export async function initiateEarningsAdjustment(input: {
  adminUserId: string;
  idempotencyKey: string;
  body: unknown;
}): Promise<InitiateAdjustmentResult> {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const providerProfileId = typeof body.providerProfileId === 'string' ? body.providerProfileId : '';
  if (!UUID.test(providerProfileId)) throw validationError([{ field: 'providerProfileId', message: 'must be a provider profile id' }]);
  if (!isEarningsAdjustmentKind(body.kind)) throw validationError([{ field: 'kind', message: 'must be credit or debit' }]);
  const kind = body.kind;
  const amount = body.amountMinorUnits;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw adjustmentAmountInvalidError();
  const currency = typeof body.currencyCode === 'string' ? body.currencyCode.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw validationError([{ field: 'currencyCode', message: 'must be a three-letter ISO-4217 code' }]);
  const reason = parseReason(body.reason);

  await requirePayoutPermission(input.adminUserId, PAYOUTS_ADJUST_ACTION);

  const [provider] = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM provider_profiles WHERE id = ${providerProfileId}`);
  if (!provider) throw validationError([{ field: 'providerProfileId', message: 'does not exist' }]);
  if (!(await availableCurrencies(providerProfileId)).includes(currency)) throw adjustmentCurrencyMismatchError();

  const signedAmount = kind === 'credit' ? amount : -amount;
  const fingerprint = idempotencyFingerprint({ providerProfileId, kind, amountMinorUnits: amount, currencyCode: currency, reason });

  const replay = async (): Promise<InitiateAdjustmentResult | null> => {
    const [existing] = await queryRows<{ id: string; admin_action_id: string; idempotency_fingerprint: string }>(
      getDb(),
      sql`SELECT id, admin_action_id, idempotency_fingerprint FROM earnings_adjustments
           WHERE provider_profile_id = ${providerProfileId} AND idempotency_key = ${input.idempotencyKey}`,
    );
    if (!existing) return null;
    if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
    return {
      outcome: 'pending_approval',
      replayed: true,
      pending: { adminActionId: existing.admin_action_id, adjustmentId: existing.id, status: 'pending_approval', providerProfileId, kind, amountMinorUnits: amount, currencyCode: currency },
    };
  };

  const replayed = await replay();
  if (replayed) return replayed;

  const adjustmentId = randomUUID();
  const initiated = await authorizeAndInitiate({
    userId: input.adminUserId,
    resource: PAYOUTS_RESOURCE,
    action: PAYOUTS_ADJUST_ACTION,
    targetType: 'earnings_adjustment',
    targetId: adjustmentId,
    reason,
  });
  // Fail closed: only a `pending_approval` outcome is honest here (§3.14).
  if (initiated.outcome !== 'pending_approval') throw approvalRequiredError();

  try {
    await getDb().execute(sql`
      INSERT INTO earnings_adjustments (
        id, provider_profile_id, kind, adjustment_amount_minor_units, adjustment_currency_code, reason,
        admin_action_id, created_by_user_id, idempotency_key, idempotency_fingerprint
      ) VALUES (
        ${adjustmentId}, ${providerProfileId}, ${kind}, ${signedAmount}, ${currency}, ${reason},
        ${initiated.adminActionId}, ${input.adminUserId}, ${input.idempotencyKey}, ${fingerprint}
      )
    `);
  } catch (err) {
    // A concurrent identical request won the idempotency race. This call's AdminAction targets no
    // row, so its execution can only ever fail closed with ADJUSTMENT_NOT_FOUND.
    if (isUniqueViolation(err, 'earnings_adjustments_idempotency_uq')) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw err;
  }

  console.log(JSON.stringify({ event: 'payout.adjustment_requested', adjustmentId, providerProfileId, amountMinorUnits: signedAmount, status: 'pending_approval' }));
  return {
    outcome: 'pending_approval',
    replayed: false,
    pending: { adminActionId: initiated.adminActionId, adjustmentId, status: 'pending_approval', providerProfileId, kind, amountMinorUnits: amount, currencyCode: currency },
  };
}

async function loadPayoutsAction(adminActionId: string, action: string) {
  if (!UUID.test(adminActionId)) return undefined;
  const [row] = await getDb()
    .select({ id: adminActions.id, status: adminActions.status, targetType: adminActions.targetType, targetId: adminActions.targetId })
    .from(adminActions)
    .where(and(eq(adminActions.id, adminActionId), eq(adminActions.resource, PAYOUTS_RESOURCE), eq(adminActions.actionType, action)));
  return row;
}

export async function executeEarningsAdjustment(input: { adminUserId: string; adminActionId: string }): Promise<EarningsAdjustmentDto> {
  await requirePayoutPermission(input.adminUserId, PAYOUTS_ADJUST_ACTION);

  const action = await loadPayoutsAction(input.adminActionId, PAYOUTS_ADJUST_ACTION);
  if (!action || action.targetType !== 'earnings_adjustment') throw adjustmentNotFoundError();
  const adjustment = await loadAdjustmentRow(action.targetId);
  if (!adjustment || adjustment.admin_action_id !== action.id) throw adjustmentNotFoundError();

  if (action.status === 'Executed') {
    // Completes an execution that crashed between spec 009's `Approved → Executed` and applying the
    // row. `Executed` proves the approval happened; an already-applied row is a second execution.
    if (adjustment.applied_at) throw approvalNotEligibleError('This action is not in a state that can be executed.');
  } else {
    // Spec 009 owns the decision: 422 APPROVAL_REQUIRED while Pending, 409 once Rejected.
    await executeApprovedAction(input.adminActionId, input.adminUserId);
  }

  await getDb().execute(sql`
    UPDATE earnings_adjustments SET applied_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${adjustment.id} AND applied_at IS NULL
  `);
  const applied = await loadAdjustmentRow(adjustment.id);
  console.log(JSON.stringify({ event: 'payout.adjustment_applied', adjustmentId: adjustment.id, providerProfileId: adjustment.provider_profile_id, amountMinorUnits: adjustment.adjustment_amount_minor_units, status: 'applied' }));
  return toAdjustmentDto(applied!, 'admin');
}

export async function initiatePayoutRetry(input: {
  adminUserId: string;
  payoutId: string;
  body: unknown;
}): Promise<PayoutRetryPendingDto> {
  const reason = parseReason(((input.body ?? {}) as Record<string, unknown>).reason);
  await requirePayoutPermissionOrNotFound(input.adminUserId, PAYOUTS_RETRY_ACTION);
  if (!UUID.test(input.payoutId)) throw payoutNotFoundError();

  return getDb().transaction(async (tx) => {
    // Serializes concurrent initiations for one payout: `admin_actions` is spec 009's table and
    // carries no uniqueness this spec could lean on, so the check-then-create is guarded here.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payout-retry:${input.payoutId}`}))`);

    const [payout] = await queryRows<{ status: string }>(tx, sql`SELECT status FROM payouts WHERE id = ${input.payoutId}`);
    if (!payout) throw payoutNotFoundError();
    if (payout.status === 'paid') throw payoutAlreadyPaidError();
    if (payout.status === 'processing') throw payoutAlreadyProcessingError();
    if (payout.status !== 'failed') throw payoutNotRetryableError();

    const [open] = await queryRows<{ id: string }>(
      tx,
      sql`SELECT id FROM admin_actions WHERE resource = ${PAYOUTS_RESOURCE} AND action_type = ${PAYOUTS_RETRY_ACTION}
             AND target_type = 'payout' AND target_id = ${input.payoutId} AND status IN ('Pending','Approved') LIMIT 1`,
    );
    if (open) throw payoutRetryAlreadyPendingError();

    const initiated = await authorizeAndInitiate({
      userId: input.adminUserId,
      resource: PAYOUTS_RESOURCE,
      action: PAYOUTS_RETRY_ACTION,
      targetType: 'payout',
      targetId: input.payoutId,
      reason,
    });
    if (initiated.outcome !== 'pending_approval') throw approvalRequiredError();

    console.log(JSON.stringify({ event: 'payout.retry_requested', payoutId: input.payoutId, status: 'failed' }));
    return { adminActionId: initiated.adminActionId, payoutId: input.payoutId, status: 'pending_approval' as const };
  });
}

export async function executePayoutRetry(input: {
  adminUserId: string;
  payoutId: string;
  adminActionId: string;
}): Promise<AdminPayoutDto> {
  await requirePayoutPermissionOrNotFound(input.adminUserId, PAYOUTS_RETRY_ACTION);
  if (!UUID.test(input.payoutId)) throw payoutNotFoundError();

  const action = await loadPayoutsAction(input.adminActionId, PAYOUTS_RETRY_ACTION);
  if (!action || action.targetType !== 'payout' || action.targetId !== input.payoutId) throw payoutNotFoundError();

  const detail = `retry:${action.id}`;
  const [payout] = await queryRows<{ status: string; provider_profile_id: string; payout_currency_code: string }>(
    getDb(),
    sql`SELECT status, provider_profile_id, payout_currency_code FROM payouts WHERE id = ${input.payoutId}`,
  );
  if (!payout) throw payoutNotFoundError();

  const [alreadyApplied] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM payouts_status_history WHERE payout_id = ${input.payoutId} AND detail = ${detail} LIMIT 1`,
  );

  if (action.status === 'Executed') {
    if (alreadyApplied) throw approvalNotEligibleError('This action is not in a state that can be executed.');
  } else {
    if (payout.status === 'paid') throw payoutAlreadyPaidError();
    if (payout.status === 'processing') throw payoutAlreadyProcessingError();
    if (payout.status !== 'failed') throw payoutNotRetryableError();
    const method = await findUsableDefaultMethod(getDb(), payout.provider_profile_id, payout.payout_currency_code);
    if (!method) throw payoutNotRetryableError({ reason: 'no_usable_payout_method' });
    await executeApprovedAction(input.adminActionId, input.adminUserId);
  }

  const outcome = await getDb().transaction((tx) =>
    reopenFailedPayout(tx, input.payoutId, { role: 'admin', userId: input.adminUserId, detail }),
  );
  if (outcome === 'no_payout_method') throw payoutNotRetryableError({ reason: 'no_usable_payout_method' });
  if (outcome === 'not_failed') throw payoutNotRetryableError();

  const { items: _items, failureReason: _failureReason, escalatedAt: _escalatedAt, ...dto } = await loadAdminPayoutDetail(input.payoutId);
  return dto;
}
