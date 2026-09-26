import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { getSandboxPayoutProvider } from '@/lib/payments/provider';
import { closeBatch } from '@/lib/payouts/ledger';
import { earningsSummary } from '@/lib/payouts/read';
import { transferPayout } from '@/lib/payouts/transfer';
import {
  accrueBooking,
  addDefaultMethod,
  payoutsFor,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from '@/lib/payouts/payouts-test-support';
import { registerModerationIntegration } from './index';
import { executeReversal, requestReversal } from './actions';
import { adminWithRole, approve, initiate, initiateApproveExecute, isDatabaseReachable, resetModerationForTests } from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

const NO_RANGE = { currency: null, range: { fromInstant: null, toInstant: null } };

/** Spec 038 AC-7 / §3.7 — the freeze through spec 024's `PayoutHoldGate`, and its normative boundary. */
describe.skipIf(!dbReachable)('payout freeze (spec 038 AC-7)', { timeout: 240_000 }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
    registerModerationIntegration(); // AFTER spec 024 resets its hold gate, exactly as instrumentation.ts orders it
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    resetModerationForTests();
  });

  it('a pending freeze holds nothing; an executed freeze holds Pass C and shows payoutOnHold; reversal releases', async () => {
    const [ts, fin] = [await adminWithRole(), await adminWithRole('finance_admin')];
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    const body = { actionType: 'payout_freeze', scope: 'provider_profile', targetUserId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId };

    const { action } = await initiate(ts, body);
    expect(action.status).toBe('pending_approval');
    expect((await earningsSummary(settled.providerProfileId, NO_RANGE)).payoutOnHold).toBe(false);

    await approve(fin, action.adminActionId!);
    const { executeModerationAction } = await import('./actions');
    await executeModerationAction({ adminUserId: ts.userId, actionId: action.id, correlationId: null });

    expect(await closeBatch(payoutId)).toBe('held');
    expect((await payoutsFor(settled.providerProfileId))[0]!.status).toBe('pending');
    expect(getSandboxPayoutProvider().transfers()).toHaveLength(0);
    expect((await earningsSummary(settled.providerProfileId, NO_RANGE)).payoutOnHold).toBe(true);

    const requested = await requestReversal({ adminUserId: ts.userId, actionId: action.id, reason: 'Investigation cleared.', correlationId: null });
    const second = await adminWithRole();
    await approve(second, requested.reversalAdminActionId!);
    await executeReversal({ adminUserId: ts.userId, actionId: action.id, correlationId: null });

    expect((await earningsSummary(settled.providerProfileId, NO_RANGE)).payoutOnHold).toBe(false);
    expect(await closeBatch(payoutId)).toBe('closed');
  });

  it('NORMATIVE BOUNDARY (§3.7): a batch already eligible before the freeze is not stopped', async () => {
    const [ts, fin] = [await adminWithRole(), await adminWithRole('finance_admin')];
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    expect(await closeBatch(payoutId)).toBe('closed'); // now `eligible`

    await initiateApproveExecute(ts, fin, {
      actionType: 'payout_freeze',
      scope: 'provider_profile',
      targetUserId: settled.scenario.provider.userId,
      providerProfileId: settled.providerProfileId,
    });
    await transferPayout(payoutId);
    expect(['processing', 'paid']).toContain((await payoutsFor(settled.providerProfileId))[0]!.status);
  });

  it('one open freeze per provider profile', async () => {
    const ts = await adminWithRole();
    const settled = await seedSettledBooking();
    const body = { actionType: 'payout_freeze', scope: 'provider_profile', targetUserId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId };
    await initiate(ts, body);
    await expect(initiate(ts, body)).rejects.toMatchObject({ code: 'MODERATION_ACTION_CONFLICT' });
  });
});
