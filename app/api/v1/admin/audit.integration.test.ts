import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { securityEvents } from '@/lib/db/schema';
import { authorizeAndInitiate, decideAction, recordPostActionReview } from '@/lib/admin-rbac/actions';
import { assignRole, revokeRole } from '@/lib/admin-rbac/role-assignment';
import { isDatabaseReachable, registerAdmin, registerAdminWithPermission, grantRole } from './admin-rbac-test-support';

const dbReachable = await isDatabaseReachable();

async function latestEventFor(userId: string, eventType: string) {
  const [row] = await getDb()
    .select()
    .from(securityEvents)
    .where(eq(securityEvents.userId, userId))
    .orderBy(desc(securityEvents.createdAt));
  expect(row?.eventType).toBe(eventType);
  return row!;
}

describe.skipIf(!dbReachable)('admin audit event emission (spec 009 AC-4, integration)', () => {
  it('AC-4: a permitted low/medium action is audited with actor/role/resource/action/target/reason and an EMPTY approval chain', async () => {
    const admin = await registerAdminWithPermission('support_admin', 'support_tickets', 'audit_close_ticket', 'low');

    await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'support_tickets',
      action: 'audit_close_ticket',
      targetType: 'support_ticket',
      targetId: 'ticket_audit_1',
      reason: 'resolved by customer',
    });

    const event = await latestEventFor(admin.userId, 'admin_rbac.action_permitted');
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.actorRoles).toEqual(['support_admin']);
    expect(metadata.resource).toBe('support_tickets');
    expect(metadata.action).toBe('audit_close_ticket');
    expect(metadata.targetType).toBe('support_ticket');
    expect(metadata.targetId).toBe('ticket_audit_1');
    expect(metadata.reason).toBe('resolved by customer');
    expect(metadata.approvalChain).toEqual([]);
  });

  it('AC-4: a high-risk action creates an audit event carrying the initiator role, then the approval decision carries the approver role + initiator/decider', async () => {
    const initiator = await registerAdminWithPermission('finance_admin', 'refunds', 'audit_refund', 'high');
    const approver = await registerAdminWithPermission('finance_admin', 'refunds', 'audit_refund', 'high');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'audit_refund',
      targetType: 'payment',
      targetId: 'pay_audit_1',
      reason: 'audited refund',
    });
    if (initiated.outcome !== 'pending_approval') throw new Error('unreachable');

    const createdEvent = await latestEventFor(initiator.userId, 'admin_rbac.action_created');
    const createdMetadata = createdEvent.metadata as Record<string, unknown>;
    expect(createdMetadata.actorRoles).toEqual(['finance_admin']);
    const createdChain = createdMetadata.approvalChain as Record<string, unknown>;
    expect(createdChain.initiatedBy).toBeTruthy();

    await decideAction({ approverUserId: approver.userId, adminActionId: initiated.adminActionId, decision: 'approved' });
    const decidedEvent = await latestEventFor(approver.userId, 'admin_rbac.action_approved');
    const decidedMetadata = decidedEvent.metadata as Record<string, unknown>;
    expect(decidedMetadata.actorRoles).toEqual(['finance_admin']);
    const decidedChain = decidedMetadata.approvalChain as Record<string, unknown>;
    expect(decidedChain.initiatedBy).toBeTruthy();
    expect(decidedChain.decidedBy).toBeTruthy();
    expect(decidedChain.decision).toBe('approved');
  });

  it('AC-4: an emergency-bypassed action, and its mandatory post-action review, are each audited with the acting admin\'s role', async () => {
    const admin = await registerAdminWithPermission('trust_safety_admin', 'moderation', 'audit_emergency_ban', 'critical');

    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource: 'moderation',
      action: 'audit_emergency_ban',
      targetType: 'user',
      targetId: 'user_audit_1',
      reason: 'active incident',
      emergencyBypass: true,
    });
    if (result.outcome !== 'emergency_bypass_executed') throw new Error('unreachable');

    const bypassEvent = await latestEventFor(admin.userId, 'admin_rbac.emergency_bypass_executed');
    const bypassMetadata = bypassEvent.metadata as Record<string, unknown>;
    expect(bypassMetadata.actorRoles).toEqual(['trust_safety_admin']);
    expect(bypassMetadata.isEmergencyBypass).toBe(true);

    await recordPostActionReview({ reviewerUserId: admin.userId, adminActionId: result.adminActionId, notes: 'confirmed necessary' });
    const reviewEvent = await latestEventFor(admin.userId, 'admin_rbac.post_action_reviewed');
    const reviewMetadata = reviewEvent.metadata as Record<string, unknown>;
    expect(reviewMetadata.actorRoles).toEqual(['trust_safety_admin']);
    expect(reviewMetadata.isEmergencyBypass).toBe(true);
  });

  it('AC-4: role assignment and revocation are audited with the acting Super Admin\'s role', async () => {
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();

    await assignRole(superAdmin.userId, target.userId, 'support_admin');
    const assignedEvent = await latestEventFor(superAdmin.userId, 'admin_rbac.role_assigned');
    expect((assignedEvent.metadata as Record<string, unknown>).actorRoles).toEqual(['super_admin']);

    await revokeRole(superAdmin.userId, target.userId, 'support_admin');
    const revokedEvent = await latestEventFor(superAdmin.userId, 'admin_rbac.role_revoked');
    expect((revokedEvent.metadata as Record<string, unknown>).actorRoles).toEqual(['super_admin']);
  });
});
