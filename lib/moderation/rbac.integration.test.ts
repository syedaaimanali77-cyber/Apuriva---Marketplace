import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { adminWithRole, initiate, isDatabaseReachable, resetModerationForTests, seedCustomer, useModerationIntegration } from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 §3.9 — the exact grant table migration 0033 seeds, read through spec 009's resolver. */
const TABLE: Array<[string, string, string, AdminRole[]]> = [
  ['moderation', 'read', 'low', ['trust_safety_admin', 'operations_admin', 'super_admin']],
  ['moderation', 'warn', 'medium', ['trust_safety_admin', 'super_admin']],
  ['moderation', 'restrict', 'medium', ['trust_safety_admin', 'super_admin']],
  ['moderation', 'suspend', 'high', ['trust_safety_admin', 'super_admin']],
  ['moderation', 'ban', 'critical', ['trust_safety_admin', 'super_admin']],
  ['moderation', 'intervene_booking', 'high', ['trust_safety_admin', 'operations_admin', 'super_admin']],
  ['moderation', 'freeze_payout', 'high', ['trust_safety_admin', 'finance_admin', 'super_admin']],
  ['moderation', 'reverse', 'high', ['trust_safety_admin', 'super_admin']],
  ['moderation', 'review_appeal', 'medium', ['trust_safety_admin', 'super_admin']],
  ['fraud_signals', 'read', 'low', ['trust_safety_admin', 'super_admin']],
  ['fraud_signals', 'triage', 'medium', ['trust_safety_admin', 'super_admin']],
];
const ROLES: AdminRole[] = ['super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin'];

describe.skipIf(!dbReachable)('moderation RBAC (spec 038 §3.9, AC-10)', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('every role holds exactly the seeded grants, at the seeded tier', async () => {
    const admins = new Map<AdminRole, string>();
    for (const role of ROLES) admins.set(role, (await adminWithRole(role)).userId);
    for (const [resource, action, tier, roles] of TABLE) {
      for (const role of ROLES) {
        const resolved = await resolvePermission(admins.get(role)!, resource, action);
        expect(resolved.allowed, `${role} ${resource}/${action}`).toBe(roles.includes(role));
        if (resolved.allowed) expect(resolved.riskTier).toBe(tier);
      }
    }
  });

  it('an admin without the per-type permission is refused 403 server-side', async () => {
    const target = await seedCustomer();
    const ops = await adminWithRole('operations_admin');
    await expect(initiate(ops, { actionType: 'ban', scope: 'account', targetUserId: target.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const finance = await adminWithRole('finance_admin');
    await expect(initiate(finance, { actionType: 'warning', scope: 'account', targetUserId: target.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const support = await adminWithRole('support_admin');
    await expect(initiate(support, { actionType: 'restriction', scope: 'account', targetUserId: target.userId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a non-admin can initiate nothing', async () => {
    const [actor, target] = [await seedCustomer(), await seedCustomer()];
    await expect(
      initiate({ ...actor, adminProfileId: 'none' }, { actionType: 'warning', scope: 'account', targetUserId: target.userId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
