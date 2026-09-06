import { describe, expect, it } from 'vitest';
import { POST as APPROVE } from './approvals/[actionId]/approve/route';
import { POST as REJECT } from './approvals/[actionId]/reject/route';
import { GET as PENDING } from './approvals/pending/route';
import { authorizeAndInitiate, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, registerAdminWithPermission, registerAdmin, grantRole } from './admin-rbac-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('admin approval workflow (spec 009 AC-1/AC-2, integration)', () => {
  it('AC-1: an admin without a matching Permission is forbidden from initiating the action at all', async () => {
    const noPermAdmin = await registerAdmin();
    await grantRole(noPermAdmin, 'support_admin');

    await expect(
      authorizeAndInitiate({
        userId: noPermAdmin.userId,
        resource: 'refunds',
        action: 'issue_large_refund',
        targetType: 'payment',
        targetId: 'pay_1',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('low/medium-risk actions proceed immediately — no AdminAction/approval row, no pending-approval entry', async () => {
    const admin = await registerAdminWithPermission('support_admin', 'support_tickets', 'close_ticket', 'low');

    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'support_tickets',
      action: 'close_ticket',
      targetType: 'support_ticket',
      targetId: 'ticket_1',
      reason: 'resolved',
    });
    expect(result.outcome).toBe('permitted');

    resetRateLimitState();
    const pending = await PENDING(authenticatedRequest('http://localhost/api/v1/admin/approvals/pending', admin.sessionId, admin.csrfToken, { method: 'GET' }));
    const { data } = await pending.json();
    expect(data).toHaveLength(0);
  });

  it('AC-2: a high-risk action creates a Pending AdminAction and does not execute until a second, distinct, authorized admin approves', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund', 'high');
    const approver = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund', 'high');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'issue_large_refund',
      targetType: 'payment',
      targetId: 'pay_42',
      reason: 'customer goodwill',
    });
    expect(initiated.outcome).toBe('pending_approval');
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    // Cannot execute yet — still Pending.
    await expect(executeApprovedAction(initiated.adminActionId, initiator.userId)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    resetRateLimitState();
    const list = await PENDING(authenticatedRequest('http://localhost/api/v1/admin/approvals/pending', approver.sessionId, approver.csrfToken, { method: 'GET' }));
    const { data } = await list.json();
    expect(data.map((a: { id: string }) => a.id)).toContain(initiated.adminActionId);

    resetRateLimitState();
    const approveRes = await APPROVE(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/approve`, approver.sessionId, approver.csrfToken, {
        method: 'POST',
      }),
    );
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).data.status).toBe('Approved');

    await executeApprovedAction(initiated.adminActionId, approver.userId);
  });

  it('self-approval is rejected with 409 SELF_APPROVAL_NOT_ALLOWED', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_2', 'high');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'issue_large_refund_2',
      targetType: 'payment',
      targetId: 'pay_43',
      reason: 'test',
    });
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    resetRateLimitState();
    const res = await APPROVE(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/approve`, initiator.sessionId, initiator.csrfToken, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('SELF_APPROVAL_NOT_ALLOWED');
  });

  it('an approver without the matching Permission is rejected with 409 APPROVAL_NOT_ELIGIBLE', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_3', 'high');
    const unauthorizedApprover = await registerAdmin();
    await grantRole(unauthorizedApprover, 'support_admin'); // holds no matching Permission

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'issue_large_refund_3',
      targetType: 'payment',
      targetId: 'pay_44',
      reason: 'test',
    });
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    resetRateLimitState();
    const res = await APPROVE(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/approve`, unauthorizedApprover.sessionId, unauthorizedApprover.csrfToken, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('APPROVAL_NOT_ELIGIBLE');
  });

  it('a duplicate decision against an already-decided (terminal) action is rejected with 409 APPROVAL_NOT_ELIGIBLE', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_4', 'high');
    const approverA = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_4', 'high');
    const approverB = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_4', 'high');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'issue_large_refund_4',
      targetType: 'payment',
      targetId: 'pay_45',
      reason: 'test',
    });
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    resetRateLimitState();
    const first = await APPROVE(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/approve`, approverA.sessionId, approverA.csrfToken, {
        method: 'POST',
      }),
    );
    expect(first.status).toBe(200);

    resetRateLimitState();
    const second = await REJECT(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/reject`, approverB.sessionId, approverB.csrfToken, {
        method: 'POST',
      }),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('APPROVAL_NOT_ELIGIBLE');
  });

  it('a rejected action is never executable', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_5', 'high');
    const approver = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_5', 'high');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'issue_large_refund_5',
      targetType: 'payment',
      targetId: 'pay_46',
      reason: 'test',
    });
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    resetRateLimitState();
    await REJECT(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${initiated.adminActionId}/reject`, approver.sessionId, approver.csrfToken, {
        method: 'POST',
      }),
    );

    await expect(executeApprovedAction(initiated.adminActionId, approver.userId)).rejects.toMatchObject({ code: 'APPROVAL_NOT_ELIGIBLE' });
  });

  it('critical risk also requires approval (not just high)', async () => {
    const initiator = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'permanent_ban', 'critical');
    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'moderation',
      action: 'permanent_ban',
      targetType: 'user',
      targetId: 'user_9',
      reason: 'severe abuse',
    });
    expect(initiated.outcome).toBe('pending_approval');
  });
});
