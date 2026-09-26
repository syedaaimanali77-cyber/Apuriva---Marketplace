import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { executeApprovedAction } from '@/lib/admin-rbac/actions';
import { queryRows } from '@/lib/offers/db';
import { executeModerationAction, initiateModerationAction } from './actions';
import { listModerationActions } from './read';
import {
  actionStatus,
  adminWithRole,
  approve,
  initiate,
  isDatabaseReachable,
  reject,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 §3.2 / AC-2 — spec 009's four-eyes, unchanged, in front of every high/critical effect. */
describe.skipIf(!dbReachable)('four-eyes approval (spec 038 AC-2)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('suspension and ban land pending_approval with a spec 009 AdminAction and NO effect', async () => {
    const admin = await adminWithRole();
    for (const actionType of ['suspension', 'ban'] as const) {
      const target = await seedCustomer();
      const { action, outcome } = await initiate(admin, { actionType, scope: 'account', targetUserId: target.userId });
      expect(outcome).toBe('pending_approval');
      expect(action.status).toBe('pending_approval');
      expect(action.adminActionId).toBeTruthy();
      expect(action.riskTier).toBe(actionType === 'ban' ? 'critical' : 'high');
      expect(await userStatus(target.userId)).toBe('active');
      const [aa] = await queryRows<{ status: string; resource: string; target_id: string }>(
        getDb(),
        sql`SELECT status, resource, target_id FROM admin_actions WHERE id = ${action.adminActionId}`,
      );
      expect(aa).toMatchObject({ status: 'Pending', resource: 'moderation', target_id: action.id });
    }
  });

  it('execution before approval is 422 APPROVAL_REQUIRED and changes nothing', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const { action } = await initiate(admin, { actionType: 'ban', scope: 'account', targetUserId: target.userId });
    await expect(executeModerationAction({ adminUserId: admin.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
      status: 422,
    });
    expect(await userStatus(target.userId)).toBe('active');
  });

  it('the initiator cannot approve their own action (spec 009 SELF_APPROVAL_NOT_ALLOWED)', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const { action } = await initiate(admin, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await expect(approve(admin, action.adminActionId!)).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
  });

  it('after a second admin approves, execution applies the effect exactly once', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'ban', scope: 'account', targetUserId: target.userId });
    await approve(b, action.adminActionId!);
    const executed = await executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null });
    expect(executed.status).toBe('active');
    expect(await userStatus(target.userId)).toBe('banned');
    await expect(executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'MODERATION_STATUS_CONFLICT',
      status: 409,
    });
  });

  it('a rejected action is reconciled to rejected, cannot execute, and no longer blocks a new one', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await reject(b, action.adminActionId!);
    await expect(executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'APPROVAL_NOT_ELIGIBLE',
      status: 409,
    });
    expect(await actionStatus(action.id)).toBe('rejected');
    const { outcome } = await initiate(a, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    expect(outcome).toBe('pending_approval');
  });

  it('a list read reconciles rejected actions too', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await reject(b, action.adminActionId!);
    const { rows } = await listModerationActions(a.userId, { targetUserId: target.userId }, { limit: 20, offset: 0 }, null);
    expect(rows.find((r) => r.id === action.id)?.status).toBe('rejected');
  });

  it('a second pending sanction for the same target is refused', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    await initiate(admin, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await expect(initiate(admin, { actionType: 'ban', scope: 'account', targetUserId: target.userId })).rejects.toMatchObject({
      code: 'MODERATION_ACTION_CONFLICT',
    });
  });

  it('crash recovery: an AdminAction already Executed completes the pending effect', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await approve(b, action.adminActionId!);
    await executeApprovedAction(action.adminActionId!, a.userId); // the crash happened right after this
    const executed = await executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: null });
    expect(executed.status).toBe('active');
    expect(await userStatus(target.userId)).toBe('suspended');
  });

  it('fails closed: a four-eyes type whose tier was mis-seeded low is 422 APPROVAL_REQUIRED', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    // Simulate a mis-seed for this test only, then restore the migration's value.
    await getDb().execute(sql`UPDATE permissions SET risk_tier = 'low' WHERE resource = 'moderation' AND action = 'suspend'`);
    try {
      await expect(
        initiateModerationAction({
          adminUserId: admin.userId,
          idempotencyKey: randomUUID(),
          body: { actionType: 'suspension', scope: 'account', targetUserId: target.userId, reason: 'r' },
          correlationId: null,
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', status: 422 });
      expect(await userStatus(target.userId)).toBe('active');
    } finally {
      await getDb().execute(sql`UPDATE permissions SET risk_tier = 'high' WHERE resource = 'moderation' AND action = 'suspend'`);
    }
  });
});
