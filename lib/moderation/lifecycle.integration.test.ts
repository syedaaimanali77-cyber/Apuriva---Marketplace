import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { adminProfiles } from '@/lib/db/schema';
import { getAccountStanding } from './standing';
import { executeReversal, requestReversal } from './actions';
import {
  actionStatus,
  adminWithRole,
  approve,
  initiate,
  initiateApproveExecute,
  isDatabaseReachable,
  providerStatus,
  resetModerationForTests,
  seedCustomer,
  seedProvider,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 §3.4 / AC-1 — lifecycle transitions, both scopes, supersede and reversal. */
describe.skipIf(!dbReachable)('moderation lifecycle (spec 038 AC-1)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('a warning is recorded active and changes no lifecycle column', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const { action, outcome } = await initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: target.userId });
    expect(outcome).toBe('applied');
    expect(action.status).toBe('active');
    expect(action.riskTier).toBe('medium');
    expect(action.adminActionId).toBeNull();
    expect(await userStatus(target.userId)).toBe('active');
  });

  it('an account restriction applies at once and cascades to the provider profile', async () => {
    const admin = await adminWithRole();
    const provider = await seedProvider();
    const { action } = await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: provider.userId });
    expect(action.status).toBe('active');
    expect(action.previousUserStanding).toBe('good');
    expect(action.previousProviderLifecycleStatus).toBe('active');
    expect(await userStatus(provider.userId)).toBe('restricted');
    expect(await providerStatus(provider.providerProfileId)).toBe('restricted');
  });

  it('a provider-scope sanction touches only the profile, never the account', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const provider = await seedProvider();
    const executed = await initiateApproveExecute(a, b, {
      actionType: 'suspension',
      scope: 'provider_profile',
      targetUserId: provider.userId,
      providerProfileId: provider.providerProfileId,
    });
    expect(executed.status).toBe('active');
    expect(await providerStatus(provider.providerProfileId)).toBe('suspended');
    expect(await userStatus(provider.userId)).toBe('active');
  });

  it('a more severe action supersedes; reversing it restores the older one and its standing', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action: restriction } = await initiate(a, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    const suspension = await initiateApproveExecute(a, b, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });

    expect(await actionStatus(restriction.id)).toBe('superseded');
    expect(suspension.previousUserStanding).toBe('restricted');
    expect(await userStatus(target.userId)).toBe('suspended');

    const requested = await requestReversal({ adminUserId: a.userId, actionId: suspension.id, reason: 'Suspension was premature.', correlationId: null });
    await approve(b, requested.reversalAdminActionId!);
    const reversed = await executeReversal({ adminUserId: a.userId, actionId: suspension.id, correlationId: null });

    expect(reversed.status).toBe('reversed');
    expect(await actionStatus(restriction.id)).toBe('active');
    expect(await userStatus(target.userId)).toBe('restricted');
  });

  it('refuses an equal or less severe sanction while one is active (409 MODERATION_ACTION_CONFLICT)', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    await expect(initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId })).rejects.toMatchObject({
      code: 'MODERATION_ACTION_CONFLICT',
      status: 409,
    });
  });

  it('reversal refuses with 409 LIFECYCLE_STATE_CHANGED when the column moved, and writes nothing', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    await getDb().execute(sql`UPDATE users SET lifecycle_status = 'active' WHERE id = ${target.userId}`);

    const requested = await requestReversal({ adminUserId: a.userId, actionId: action.id, reason: 'Undo it.', correlationId: null });
    await approve(b, requested.reversalAdminActionId!);
    await expect(executeReversal({ adminUserId: a.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'LIFECYCLE_STATE_CHANGED',
    });
    expect(await actionStatus(action.id)).toBe('active');
  });

  it('a deletion_pending account: the column is untouched and the standing is carried by the action', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    await getDb().execute(sql`UPDATE users SET lifecycle_status = 'deletion_pending' WHERE id = ${target.userId}`);
    await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId });
    expect(await userStatus(target.userId)).toBe('deletion_pending');
    expect(await getAccountStanding(getDb(), target.userId)).toBe('restricted');
  });

  it('refuses a deleted account, an admin account and an already-banned profile (409 TARGET_NOT_MODERATABLE)', async () => {
    const admin = await adminWithRole();
    const deleted = await seedCustomer();
    await getDb().execute(sql`UPDATE users SET lifecycle_status = 'deleted' WHERE id = ${deleted.userId}`);
    await expect(initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: deleted.userId })).rejects.toMatchObject({
      code: 'TARGET_NOT_MODERATABLE',
      details: { reason: 'account_deleted' },
    });

    const otherAdmin = await adminWithRole();
    await expect(initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: otherAdmin.userId })).rejects.toMatchObject({
      code: 'TARGET_NOT_MODERATABLE',
      details: { reason: 'admin_account' },
    });

    const provider = await seedProvider();
    await getDb().execute(sql`UPDATE provider_profiles SET lifecycle_status = 'banned' WHERE id = ${provider.providerProfileId}`);
    await expect(
      initiate(admin, { actionType: 'restriction', scope: 'provider_profile', targetUserId: provider.userId, providerProfileId: provider.providerProfileId }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_MODERATABLE', details: { reason: 'provider_banned' } });
    expect((await getDb().select().from(adminProfiles)).length).toBeGreaterThan(0);
  });

  it('404s a missing target, a foreign provider profile and a booking the target is not part of', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const provider = await seedProvider();
    await expect(
      initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: '00000000-0000-4000-8000-00000000abcd' }),
    ).rejects.toMatchObject({ status: 404, details: { field: 'targetUserId' } });
    await expect(
      initiate(admin, { actionType: 'warning', scope: 'provider_profile', targetUserId: target.userId, providerProfileId: provider.providerProfileId }),
    ).rejects.toMatchObject({ status: 404, details: { field: 'providerProfileId' } });
    await expect(
      initiate(admin, {
        actionType: 'booking_intervention',
        scope: 'booking',
        targetUserId: target.userId,
        bookingId: '00000000-0000-4000-8000-00000000abcd',
        refundTreatment: 'policy',
      }),
    ).rejects.toMatchObject({ status: 404, details: { field: 'bookingId' } });
  });
});
