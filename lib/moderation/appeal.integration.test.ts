import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as fileAppealRoute } from '@/app/api/v1/moderation-actions/[id]/appeals/route';
import { loginAgain, registerEmail } from '@/app/api/v1/users/me/privacy-test-support';
import { uniqueEmail } from '@/app/api/v1/auth/test-support';
import { decideModerationAppeal, fileModerationAppeal, listModerationAppeals } from './appeals';
import {
  actionStatus,
  adminWithRole,
  asUser,
  initiate,
  initiateApproveExecute,
  isDatabaseReachable,
  json,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

function file(userId: string, actionId: string, statement = 'This was a misunderstanding.') {
  return fileModerationAppeal({ userId, actionId, statement, idempotencyKey: randomUUID(), fingerprint: randomUUID(), correlationId: null });
}

/** Spec 038 AC-5 — one appeal, decided by a different admin; upheld reverses. */
describe.skipIf(!dbReachable)('moderation appeals (spec 038 AC-5)', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('the target files exactly one appeal; anyone else gets 404', async () => {
    const admin = await adminWithRole();
    const [target, stranger] = [await seedCustomer(), await seedCustomer()];
    const { action } = await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });

    await expect(file(stranger.userId, action.id)).rejects.toMatchObject({ status: 404 });
    const { appeal } = await file(target.userId, action.id);
    expect(appeal).toMatchObject({ status: 'pending', decisionReason: null, decidedByAdminUserId: null });
    await expect(file(target.userId, action.id)).rejects.toMatchObject({ code: 'APPEAL_ALREADY_FILED', status: 409 });
  });

  it('a pending or reversed action is not appealable', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const { action } = await initiate(admin, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    await expect(file(target.userId, action.id)).rejects.toMatchObject({ code: 'APPEAL_NOT_AVAILABLE' });
  });

  it('the initiator and the approver may not decide; a third admin may, and upheld reverses', async () => {
    const [a, b, c] = [await adminWithRole(), await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const suspension = await initiateApproveExecute(a, b, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    const { appeal } = await file(target.userId, suspension.id);

    for (const decider of [a, b]) {
      await expect(
        decideModerationAppeal({ adminUserId: decider.userId, appealId: appeal.id, decision: 'upheld', reason: 'x', correlationId: null }),
      ).rejects.toMatchObject({ code: 'APPEAL_REQUIRES_DIFFERENT_ADMIN', status: 403 });
    }

    const decided = await decideModerationAppeal({ adminUserId: c.userId, appealId: appeal.id, decision: 'upheld', reason: 'Evidence did not support it.', correlationId: null });
    expect(decided).toMatchObject({ status: 'upheld', decidedByAdminUserId: c.userId });
    expect(await actionStatus(suspension.id)).toBe('reversed');
    expect(await userStatus(target.userId)).toBe('active');

    await expect(
      decideModerationAppeal({ adminUserId: c.userId, appealId: appeal.id, decision: 'denied', reason: 'x', correlationId: null }),
    ).rejects.toMatchObject({ code: 'APPEAL_STATUS_CONFLICT' });
  });

  it('denied leaves the action in effect', async () => {
    const [a, c] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    const { appeal } = await file(target.userId, action.id);
    await decideModerationAppeal({ adminUserId: c.userId, appealId: appeal.id, decision: 'denied', reason: 'Upheld on review.', correlationId: null });
    expect(await actionStatus(action.id)).toBe('active');
    expect(await userStatus(target.userId)).toBe('restricted');
  });

  it('a banned user can still reach the appeal route (allow-list), and the queue lists it', async () => {
    const [a, b, c] = [await adminWithRole(), await adminWithRole(), await adminWithRole()];
    const email = uniqueEmail();
    await registerEmail(email);
    resetRateLimitState();
    const session = await loginAgain(email);
    const ban = await initiateApproveExecute(a, b, { actionType: 'ban', scope: 'account', targetUserId: session.userId });

    resetRateLimitState();
    const fresh = await loginAgain(email);
    const response = await fileAppealRoute(asUser(fresh, `/moderation-actions/${ban.id}/appeals`, { body: { statement: 'Please review my ban.' } }));
    expect(response.status).toBe(201);
    const body = await json(response);

    const { rows } = await listModerationAppeals(c.userId, 'pending', { limit: 50, offset: 0 });
    expect(rows.some((r) => r.id === body.data.id)).toBe(true);
  });

  it('only moderation/review_appeal lists or decides appeals', async () => {
    const ops = await adminWithRole('operations_admin');
    await expect(listModerationAppeals(ops.userId, undefined, { limit: 10, offset: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
