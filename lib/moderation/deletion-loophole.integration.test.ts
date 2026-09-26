import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { cancelDeletion, requestDeletion } from '@/lib/privacy/deletion';
import { executeReversal, requestReversal } from './actions';
import { getAccountStanding } from './standing';
import {
  adminWithRole,
  approve,
  initiate,
  initiateApproveExecute,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 AC-11 / X-6 — requesting then cancelling deletion never lifts a sanction. */
describe.skipIf(!dbReachable)('deletion loophole (spec 038 AC-11)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('banned → request deletion → still banned during grace → cancel → banned, not active', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    await initiateApproveExecute(a, b, { actionType: 'ban', scope: 'account', targetUserId: target.userId });

    await requestDeletion(target.userId);
    expect(await userStatus(target.userId)).toBe('deletion_pending');
    expect(await getAccountStanding(getDb(), target.userId)).toBe('banned');

    await cancelDeletion(target.userId);
    expect(await userStatus(target.userId)).toBe('banned');
  });

  it('a restriction survives request-then-cancel too', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    await requestDeletion(target.userId);
    await cancelDeletion(target.userId);
    expect(await userStatus(target.userId)).toBe('restricted');
  });

  it('a sanction applied WHILE deletion is pending is kept when deletion is cancelled', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    await requestDeletion(target.userId);
    await initiateApproveExecute(a, b, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    expect(await userStatus(target.userId)).toBe('deletion_pending');
    await cancelDeletion(target.userId);
    expect(await userStatus(target.userId)).toBe('suspended');
  });

  it('an account in good standing still returns to active — and only the §3.4 reversal restores active from a sanction', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const clean = await seedCustomer();
    await requestDeletion(clean.userId);
    await cancelDeletion(clean.userId);
    expect(await userStatus(clean.userId)).toBe('active');

    const target = await seedCustomer();
    const suspension = await initiateApproveExecute(a, b, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    const requested = await requestReversal({ adminUserId: a.userId, actionId: suspension.id, reason: 'Reinstated.', correlationId: null });
    await approve(b, requested.reversalAdminActionId!);
    await executeReversal({ adminUserId: a.userId, actionId: suspension.id, correlationId: null });
    expect(await userStatus(target.userId)).toBe('active');
  });
});
