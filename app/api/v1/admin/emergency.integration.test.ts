import { describe, expect, it } from 'vitest';
import { POST as POST_ACTION_REVIEW } from './actions/[actionId]/post-action-review/route';
import { GET as PENDING_REVIEW } from './actions/pending-review/route';
import { POST as APPROVE } from './approvals/[actionId]/approve/route';
import { authorizeAndInitiate, decideAction } from '@/lib/admin-rbac/actions';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, registerAdminWithPermission } from './admin-rbac-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('emergency bypass + mandatory post-action review (spec 009 AC-3, integration)', () => {
  it('AC-3: an emergency-bypassed critical action executes immediately (no approval wait) and enters PostActionReviewRequired', async () => {
    const admin = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'emergency_permanent_ban', 'critical');

    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'moderation',
      action: 'emergency_permanent_ban',
      targetType: 'user',
      targetId: 'user_99',
      reason: 'active safety incident',
      emergencyBypass: true,
    });
    expect(result.outcome).toBe('emergency_bypass_executed');
    if (result.outcome !== 'emergency_bypass_executed') throw new Error('unreachable');

    resetRateLimitState();
    const list = await PENDING_REVIEW(
      authenticatedRequest('http://localhost/api/v1/admin/actions/pending-review', admin.sessionId, admin.csrfToken, { method: 'GET' }),
    );
    const { data } = await list.json();
    expect(data.map((a: { id: string; isEmergencyBypass: boolean }) => a.id)).toContain(result.adminActionId);
    expect(data.find((a: { id: string }) => a.id === result.adminActionId)!.isEmergencyBypass).toBe(true);
  });

  it('AC-3: cannot be silently closed — approving/rejecting a bypassed action is not eligible; only post-action-review closes it', async () => {
    const admin = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'emergency_ban_2', 'critical');
    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'moderation',
      action: 'emergency_ban_2',
      targetType: 'user',
      targetId: 'user_100',
      reason: 'active safety incident',
      emergencyBypass: true,
    });
    if (result.outcome !== 'emergency_bypass_executed') throw new Error('unreachable');

    resetRateLimitState();
    const approveAttempt = await APPROVE(
      authenticatedRequest(`http://localhost/api/v1/admin/approvals/${result.adminActionId}/approve`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
      }),
    );
    expect(approveAttempt.status).toBe(409);
    expect((await approveAttempt.json()).code).toBe('APPROVAL_NOT_ELIGIBLE');

    await expect(decideAction({ approverUserId: admin.userId, adminActionId: result.adminActionId, decision: 'approved' })).rejects.toMatchObject({
      code: 'APPROVAL_NOT_ELIGIBLE',
    });
  });

  it('AC-3: recording the mandatory post-action review moves it to PostActionReviewed and removes it from the pending-review list', async () => {
    const admin = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'emergency_ban_3', 'critical');
    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'moderation',
      action: 'emergency_ban_3',
      targetType: 'user',
      targetId: 'user_101',
      reason: 'active safety incident',
      emergencyBypass: true,
    });
    if (result.outcome !== 'emergency_bypass_executed') throw new Error('unreachable');

    resetRateLimitState();
    const review = await POST_ACTION_REVIEW(
      authenticatedRequest(`http://localhost/api/v1/admin/actions/${result.adminActionId}/post-action-review`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { notes: 'Confirmed necessary given the active incident; no further action needed.' },
      }),
    );
    expect(review.status).toBe(200);
    expect((await review.json()).data.status).toBe('PostActionReviewed');

    resetRateLimitState();
    const list = await PENDING_REVIEW(
      authenticatedRequest('http://localhost/api/v1/admin/actions/pending-review', admin.sessionId, admin.csrfToken, { method: 'GET' }),
    );
    const { data } = await list.json();
    expect(data.map((a: { id: string }) => a.id)).not.toContain(result.adminActionId);
  });

  it('a second post-action-review attempt on an already-reviewed action is rejected with 409 APPROVAL_NOT_ELIGIBLE', async () => {
    const admin = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'emergency_ban_4', 'critical');
    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'moderation',
      action: 'emergency_ban_4',
      targetType: 'user',
      targetId: 'user_102',
      reason: 'active safety incident',
      emergencyBypass: true,
    });
    if (result.outcome !== 'emergency_bypass_executed') throw new Error('unreachable');

    resetRateLimitState();
    await POST_ACTION_REVIEW(
      authenticatedRequest(`http://localhost/api/v1/admin/actions/${result.adminActionId}/post-action-review`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { notes: 'first review' },
      }),
    );

    resetRateLimitState();
    const second = await POST_ACTION_REVIEW(
      authenticatedRequest(`http://localhost/api/v1/admin/actions/${result.adminActionId}/post-action-review`, admin.sessionId, admin.csrfToken, {
        method: 'POST',
        body: { notes: 'second review attempt' },
      }),
    );
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('APPROVAL_NOT_ELIGIBLE');
  });

  it('emergency bypass is only honored for critical risk — a high-risk request with the bypass flag still goes to Pending', async () => {
    const admin = await registerAdminWithPermission('finance_admin', 'refunds', 'issue_large_refund_bypass_attempt', 'high');
    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'refunds',
      action: 'issue_large_refund_bypass_attempt',
      targetType: 'payment',
      targetId: 'pay_200',
      reason: 'attempted bypass on a merely high-risk action',
      emergencyBypass: true,
    });
    expect(result.outcome).toBe('pending_approval');
  });
});
