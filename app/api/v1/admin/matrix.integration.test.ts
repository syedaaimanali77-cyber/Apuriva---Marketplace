import { describe, expect, it } from 'vitest';
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import { authorizeAndInitiate } from '@/lib/admin-rbac/actions';
import { isDatabaseReachable, registerAdmin, grantRole, seedPermission } from './admin-rbac-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('server-side permission resolution matrix (spec 009 AC-1, integration)', () => {
  it('AC-1: an admin with only Support cannot resolve a Finance-scoped permission, regardless of any (nonexistent) frontend claim', async () => {
    const supportOnly = await registerAdmin();
    await grantRole(supportOnly, 'support_admin');
    await seedPermission('finance_admin', 'refunds', 'matrix_issue_refund', 'high');

    const resolved = await resolvePermission(supportOnly.userId, 'refunds', 'matrix_issue_refund');
    expect(resolved.allowed).toBe(false);

    await expect(
      authorizeAndInitiate({
        userId: supportOnly.userId,
        resource: 'refunds',
        action: 'matrix_issue_refund',
        targetType: 'payment',
        targetId: 'pay_matrix_1',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a role with the matching Permission resolves allowed: true with the declared risk tier', async () => {
    const financeAdmin = await registerAdmin();
    await grantRole(financeAdmin, 'finance_admin');
    await seedPermission('finance_admin', 'refunds', 'matrix_issue_refund_2', 'high');

    const resolved = await resolvePermission(financeAdmin.userId, 'refunds', 'matrix_issue_refund_2');
    expect(resolved).toEqual({ allowed: true, riskTier: 'high' });
  });

  it('an admin with zero roles is denied everything', async () => {
    const noRoles = await registerAdmin();
    const resolved = await resolvePermission(noRoles.userId, 'refunds', 'matrix_issue_refund_2');
    expect(resolved.allowed).toBe(false);
  });

  it('a non-admin user (no AdminProfile at all) is denied everything', async () => {
    const resolved = await resolvePermission('00000000-0000-0000-0000-000000000000', 'refunds', 'matrix_issue_refund_2');
    expect(resolved).toEqual({ allowed: false, riskTier: null });
  });

  it('holding an unrelated role does not leak permission for a resource/action it was never granted', async () => {
    const contentAdmin = await registerAdmin();
    await grantRole(contentAdmin, 'content_admin');
    await seedPermission('finance_admin', 'refunds', 'matrix_issue_refund_3', 'high');

    const resolved = await resolvePermission(contentAdmin.userId, 'refunds', 'matrix_issue_refund_3');
    expect(resolved.allowed).toBe(false);
  });

  it('when two of the admin\'s roles grant the same action at different tiers, the higher tier wins', async () => {
    const dualRole = await registerAdmin();
    await grantRole(dualRole, 'support_admin');
    await grantRole(dualRole, 'finance_admin');
    await seedPermission('support_admin', 'shared_resource', 'shared_action', 'low');
    await seedPermission('finance_admin', 'shared_resource', 'shared_action', 'critical');

    const resolved = await resolvePermission(dualRole.userId, 'shared_resource', 'shared_action');
    expect(resolved).toEqual({ allowed: true, riskTier: 'critical' });
  });
});
