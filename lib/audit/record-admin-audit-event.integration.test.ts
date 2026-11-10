import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { authorizeAndInitiate, decideAction, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { grantRole, registerAdmin, seedPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { auditRowsByEventType, isDatabaseReachable, uniqueTag } from './audit-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 039 AC-1 — `recordAdminAuditEvent()` (spec 009's hook, X-2) writes exactly one complete,
 * durable `audit_logs` row per call, with the spec 009 approval reference where there is one.
 */
describe.skipIf(!dbReachable)('recordAdminAuditEvent → audit_logs (spec 039 AC-1)', { timeout: 120_000 }, () => {
  it('writes one row carrying every §72 field, mapped column by column', async () => {
    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');
    const eventType = uniqueTag('spec039.full');
    const before = Date.now();

    await recordAdminAuditEvent({
      actorUserId: admin.userId,
      actorRoles: ['trust_safety_admin'],
      eventType,
      resource: 'safety_reports',
      action: 'read',
      targetType: 'safety_report',
      targetId: 'queue',
      reason: 'routine review',
      approvalChain: { initiatedBy: 'someone' },
      isEmergencyBypass: false,
      correlationId: 'corr-039-full',
      before: { priority: 'low' },
      after: { priority: 'high' },
    });

    const rows = await auditRowsByEventType(eventType);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      actorType: 'admin',
      actorUserId: admin.userId,
      actorRoles: ['trust_safety_admin'],
      eventType,
      resource: 'safety_reports',
      action: 'read',
      targetType: 'safety_report',
      targetId: 'queue',
      reason: 'routine review',
      beforeValue: { priority: 'low' },
      afterValue: { priority: 'high' },
      approvalRef: null,
      approvalChain: { initiatedBy: 'someone' },
      isEmergencyBypass: false,
      correlationId: 'corr-039-full',
      version: 1,
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('a caller holding no admin role (spec 038 appellant) is recorded as a user actor', async () => {
    const user = await registerAndLogin();
    const eventType = uniqueTag('spec039.user');
    await recordAdminAuditEvent({
      actorUserId: user.userId,
      actorRoles: [],
      eventType,
      resource: 'moderation',
      action: 'appeal_filed',
      approvalChain: [],
    });
    const [row] = await auditRowsByEventType(eventType);
    expect(row).toMatchObject({ actorType: 'user', actorUserId: user.userId, actorRoles: [], targetType: null, targetId: null });
  });

  it('before/after are recorded only when provided: absent is SQL NULL, an explicit null is JSON null', async () => {
    const admin = await registerAdmin();
    await grantRole(admin, 'support_admin');
    const without = uniqueTag('spec039.nobefore');
    const withNull = uniqueTag('spec039.nullbefore');
    const base = { actorUserId: admin.userId, actorRoles: ['support_admin' as const], resource: 'support', action: 'x', approvalChain: [] };
    await recordAdminAuditEvent({ ...base, eventType: without });
    await recordAdminAuditEvent({ ...base, eventType: withNull, before: null, after: { x: 1 } });

    const rows = await queryRows<{ event_type: string; before_null: boolean; before_kind: string | null }>(
      getDb(),
      sql`SELECT event_type, before_value IS NULL AS before_null, jsonb_typeof(before_value) AS before_kind
            FROM audit_logs WHERE event_type IN (${without}, ${withNull})`,
    );
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, r]));
    expect(byType[without]).toMatchObject({ before_null: true, before_kind: null });
    expect(byType[withNull]).toMatchObject({ before_null: false, before_kind: 'null' });
  });

  it('spec 009 four-eyes: created, approved and executed all carry approval_ref = the AdminAction (X-3)', async () => {
    const resource = uniqueTag('spec039res');
    await seedPermission('finance_admin', resource, 'override', 'high');
    const initiator = await registerAdmin();
    await grantRole(initiator, 'finance_admin');
    const approver = await registerAdmin();
    await grantRole(approver, 'finance_admin');

    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource,
      action: 'override',
      targetType: 'booking',
      targetId: 'booking-39',
      reason: 'double charge',
    });
    expect(initiated.outcome).toBe('pending_approval');
    const adminActionId = (initiated as { adminActionId: string }).adminActionId;
    await decideAction({ approverUserId: approver.userId, adminActionId, decision: 'approved' });
    await executeApprovedAction(adminActionId, initiator.userId);

    const rows = await queryRows<{ event_type: string; approval_ref: string | null; actor_user_id: string; approval_chain: Record<string, unknown> }>(
      getDb(),
      sql`SELECT event_type, approval_ref, actor_user_id, approval_chain FROM audit_logs
           WHERE resource = ${resource} ORDER BY created_at, id`,
    );
    expect(rows.map((r) => r.event_type)).toEqual(['admin_rbac.action_created', 'admin_rbac.action_approved', 'admin_rbac.action_executed']);
    for (const row of rows) expect(row.approval_ref).toBe(adminActionId);
    expect(rows[1]!.actor_user_id).toBe(approver.userId);
    expect(rows[1]!.approval_chain).toMatchObject({ decision: 'approved', decidedBy: approver.adminProfileId, initiatedBy: initiator.adminProfileId });
  });

  it('a rejected action is audited with its approval_ref too', async () => {
    const resource = uniqueTag('spec039rej');
    await seedPermission('finance_admin', resource, 'override', 'high');
    const initiator = await registerAdmin();
    await grantRole(initiator, 'finance_admin');
    const approver = await registerAdmin();
    await grantRole(approver, 'finance_admin');
    const initiated = await authorizeAndInitiate({ userId: initiator.userId, resource, action: 'override', targetType: 'booking', targetId: 'b', reason: 'r' });
    const adminActionId = (initiated as { adminActionId: string }).adminActionId;
    await decideAction({ approverUserId: approver.userId, adminActionId, decision: 'rejected' });
    const [row] = await queryRows<{ approval_ref: string }>(
      getDb(),
      sql`SELECT approval_ref FROM audit_logs WHERE resource = ${resource} AND event_type = 'admin_rbac.action_rejected'`,
    );
    expect(row!.approval_ref).toBe(adminActionId);
  });

  it('an emergency bypass is flagged and references its AdminAction', async () => {
    const resource = uniqueTag('spec039crit');
    await seedPermission('super_admin', resource, 'wipe', 'critical');
    const admin = await registerAdmin();
    await grantRole(admin, 'super_admin');
    const result = await authorizeAndInitiate({
      userId: admin.userId,
      resource,
      action: 'wipe',
      targetType: 'thing',
      targetId: 't',
      reason: 'incident',
      emergencyBypass: true,
    });
    const adminActionId = (result as { adminActionId: string }).adminActionId;
    const [row] = await queryRows<{ is_emergency_bypass: boolean; approval_ref: string }>(
      getDb(),
      sql`SELECT is_emergency_bypass, approval_ref FROM audit_logs WHERE resource = ${resource}`,
    );
    expect(row).toMatchObject({ is_emergency_bypass: true, approval_ref: adminActionId });
  });

  it('a low/medium permitted action has no approval reference and an empty chain', async () => {
    const resource = uniqueTag('spec039low');
    await seedPermission('support_admin', resource, 'close', 'low');
    const admin = await registerAdmin();
    await grantRole(admin, 'support_admin');
    await authorizeAndInitiate({ userId: admin.userId, resource, action: 'close', targetType: 'ticket', targetId: 't1', reason: 'done' });
    const [row] = await queryRows<{ event_type: string; approval_ref: string | null; approval_chain: unknown }>(
      getDb(),
      sql`SELECT event_type, approval_ref, approval_chain FROM audit_logs WHERE resource = ${resource}`,
    );
    expect(row).toEqual({ event_type: 'admin_rbac.action_permitted', approval_ref: null, approval_chain: [] });
  });
});
