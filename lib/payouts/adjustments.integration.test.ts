import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import { decideAction } from '@/lib/admin-rbac/actions';
import { queryRows } from '@/lib/offers/db';
import { seedPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { executeEarningsAdjustment, initiateEarningsAdjustment } from './admin';
import { accrueAdjustment, createEarningsLineForBooking } from './ledger';
import { summaryFigures } from './read';
import {
  financeAdmin,
  isDatabaseReachable,
  itemsFor,
  payoutsFor,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const ZERO_RANGE = { fromInstant: null, toInstant: null };

/** Spec 024 §3.10 — Finance-approved, amount-bound, immutable earnings adjustments (AC-9). */
describe.skipIf(!dbReachable)('earnings adjustments (spec 024 §3.10)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  async function providerWithLedger() {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    return settled;
  }

  const body = (providerProfileId: string, overrides: Record<string, unknown> = {}) => ({
    providerProfileId,
    kind: 'credit',
    amountMinorUnits: 5_000,
    currencyCode: 'PKR',
    reason: 'Goodwill credit for a cancelled job',
    ...overrides,
  });

  it('initiation creates a Pending AdminAction and an unapplied row that counts in no figure or batch', async () => {
    const settled = await providerWithLedger();
    const before = await summaryFigures(settled.providerProfileId, 'PKR', ZERO_RANGE);
    const admin = await financeAdmin();

    const { pending } = await initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k1', body: body(settled.providerProfileId) });
    expect(pending.status).toBe('pending_approval');

    const [action] = await queryRows<{ status: string; target_id: string; risk_tier: string }>(getDb(), sql`SELECT status, target_id, risk_tier FROM admin_actions WHERE id = ${pending.adminActionId}`);
    expect(action).toMatchObject({ status: 'Pending', target_id: pending.adjustmentId, risk_tier: 'high' });

    expect(await summaryFigures(settled.providerProfileId, 'PKR', ZERO_RANGE)).toEqual(before);
    expect(await accrueAdjustment(pending.adjustmentId)).toBe(false);
    await expectDatabaseRejection(
      async () => {
        const [open] = await payoutsFor(settled.providerProfileId);
        const batchId = open?.id ?? (await getDb().transaction(async (tx) => (await import('./ledger')).lockOpenBatch(tx, settled.providerProfileId, 'PKR')));
        await getDb().execute(sql`INSERT INTO payout_items (payout_id, kind, adjustment_id, item_amount_minor_units, item_currency_code) VALUES (${batchId}, 'adjustment', ${pending.adjustmentId}, 5000, 'PKR')`);
      },
      /unapplied adjustment/,
    );
  });

  it('execution while Pending is 422 APPROVAL_REQUIRED; self-approval is 409; a rejected action never applies', async () => {
    const settled = await providerWithLedger();
    const initiator = await financeAdmin();
    const { pending } = await initiateEarningsAdjustment({ adminUserId: initiator.userId, idempotencyKey: 'k2', body: body(settled.providerProfileId) });

    await expectError(() => executeEarningsAdjustment({ adminUserId: initiator.userId, adminActionId: pending.adminActionId }), 'APPROVAL_REQUIRED');
    await expectError(() => decideAction({ approverUserId: initiator.userId, adminActionId: pending.adminActionId, decision: 'approved' }), 'SELF_APPROVAL_NOT_ALLOWED');

    const approver = await financeAdmin();
    await decideAction({ approverUserId: approver.userId, adminActionId: pending.adminActionId, decision: 'rejected' });
    await expectError(() => executeEarningsAdjustment({ adminUserId: initiator.userId, adminActionId: pending.adminActionId }), 'APPROVAL_NOT_ELIGIBLE');
    const [row] = await queryRows<{ applied_at: Date | null }>(getDb(), sql`SELECT applied_at FROM earnings_adjustments WHERE id = ${pending.adjustmentId}`);
    expect(row!.applied_at).toBeNull();
  });

  it('execution applies exactly the approved figures once; a second execution is 409 and applies nothing', async () => {
    const settled = await providerWithLedger();
    const before = await summaryFigures(settled.providerProfileId, 'PKR', ZERO_RANGE);
    const initiator = await financeAdmin();
    const approver = await financeAdmin('super_admin');
    const { pending } = await initiateEarningsAdjustment({ adminUserId: initiator.userId, idempotencyKey: 'k3', body: body(settled.providerProfileId, { kind: 'debit', amountMinorUnits: 1_234 }) });
    await decideAction({ approverUserId: approver.userId, adminActionId: pending.adminActionId, decision: 'approved' });

    const applied = await executeEarningsAdjustment({ adminUserId: approver.userId, adminActionId: pending.adminActionId });
    expect(applied.adjustmentAmountMinorUnits).toBe(-1_234);
    expect(applied.appliedAt).not.toBeNull();
    await expectError(() => executeEarningsAdjustment({ adminUserId: approver.userId, adminActionId: pending.adminActionId }), 'APPROVAL_NOT_ELIGIBLE');

    const after = await summaryFigures(settled.providerProfileId, 'PKR', ZERO_RANGE);
    expect(after.adjustmentsAmountMinorUnits - before.adjustmentsAmountMinorUnits).toBe(-1_234);
    expect(after.netAmountMinorUnits - before.netAmountMinorUnits).toBe(-1_234);

    expect(await accrueAdjustment(pending.adjustmentId)).toBe(true);
    const open = (await payoutsFor(settled.providerProfileId)).find((p) => p.status === 'pending')!;
    expect((await itemsFor(open.id))[0]).toMatchObject({ kind: 'adjustment', item_amount_minor_units: -1_234 });
  });

  it('an adjustment cannot be updated (other than applied_at once) or deleted', async () => {
    const settled = await providerWithLedger();
    const admin = await financeAdmin();
    const { pending } = await initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k4', body: body(settled.providerProfileId) });
    await expectDatabaseRejection(() => getDb().execute(sql`UPDATE earnings_adjustments SET adjustment_amount_minor_units = 999999 WHERE id = ${pending.adjustmentId}`), /immutable/);
    await expectDatabaseRejection(() => getDb().execute(sql`DELETE FROM earnings_adjustments WHERE id = ${pending.adjustmentId}`), /never deleted/);
  });

  it('the sign constraint rejects a mismatched kind', async () => {
    const settled = await providerWithLedger();
    const admin = await financeAdmin();
    const { pending } = await initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k5', body: body(settled.providerProfileId) });
    await expectDatabaseRejection(
      () => getDb().execute(sql`
        INSERT INTO earnings_adjustments (provider_profile_id, kind, adjustment_amount_minor_units, adjustment_currency_code, reason, admin_action_id, created_by_user_id, idempotency_key, idempotency_fingerprint)
        SELECT provider_profile_id, 'credit', -1, 'PKR', 'x', gen_random_uuid(), created_by_user_id, 'other', 'f' FROM earnings_adjustments WHERE id = ${pending.adjustmentId}`),
      /earnings_adjustments_sign_ck|admin_actions/,
    );
  });

  it('a non-finance admin is 403, validation rejects bad amounts and currencies, and idempotent replay creates no second action', async () => {
    const settled = await providerWithLedger();
    const support = await financeAdmin('support_admin');
    await expectError(() => initiateEarningsAdjustment({ adminUserId: support.userId, idempotencyKey: 'k6', body: body(settled.providerProfileId) }), 'FORBIDDEN');

    const admin = await financeAdmin();
    await expectError(() => initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k7', body: body(settled.providerProfileId, { amountMinorUnits: 0 }) }), 'ADJUSTMENT_AMOUNT_INVALID');
    await expectError(() => initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k7', body: body(settled.providerProfileId, { amountMinorUnits: 1.5 }) }), 'ADJUSTMENT_AMOUNT_INVALID');
    await expectError(() => initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k7', body: body(settled.providerProfileId, { currencyCode: 'USD' }) }), 'ADJUSTMENT_CURRENCY_MISMATCH');

    const first = await initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k8', body: body(settled.providerProfileId) });
    const replay = await initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k8', body: body(settled.providerProfileId) });
    expect(replay.replayed).toBe(true);
    expect(replay.pending.adminActionId).toBe(first.pending.adminActionId);
    await expectError(() => initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k8', body: body(settled.providerProfileId, { amountMinorUnits: 6_000 }) }), 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('a mis-seeded low tier fails closed with APPROVAL_REQUIRED rather than applying without a second admin', async () => {
    const settled = await providerWithLedger();
    const admin = await financeAdmin('analytics_admin');
    await seedPermission('analytics_admin', 'payouts', 'adjust', 'low');
    try {
      await expectError(() => initiateEarningsAdjustment({ adminUserId: admin.userId, idempotencyKey: 'k9', body: body(settled.providerProfileId) }), 'APPROVAL_REQUIRED');
      const rows = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM earnings_adjustments WHERE idempotency_key = 'k9'`);
      expect(rows).toHaveLength(0);
    } finally {
      await getDb().execute(sql`DELETE FROM permissions WHERE resource = 'payouts' AND action = 'adjust' AND role_id = (SELECT id FROM roles WHERE name = 'analytics_admin')`);
    }
  });

  it('an orphaned action whose row was never written fails closed with 404', async () => {
    const admin = await financeAdmin();
    const approver = await financeAdmin();
    const { authorizeAndInitiate } = await import('@/lib/admin-rbac/actions');
    const initiated = await authorizeAndInitiate({ userId: admin.userId, resource: 'payouts', action: 'adjust', targetType: 'earnings_adjustment', targetId: crypto.randomUUID(), reason: 'orphan' });
    if (initiated.outcome !== 'pending_approval') throw new Error('expected pending');
    await decideAction({ approverUserId: approver.userId, adminActionId: initiated.adminActionId, decision: 'approved' });
    await expectError(() => executeEarningsAdjustment({ adminUserId: approver.userId, adminActionId: initiated.adminActionId }), 'ADJUSTMENT_NOT_FOUND');
  });
});
