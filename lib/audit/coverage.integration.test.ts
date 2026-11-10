import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authorizeAndInitiate, decideAction, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { assignRole } from '@/lib/admin-rbac/role-assignment';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { PATCH as PATCH_WEIGHTS } from '@/app/api/v1/admin/services/[id]/matching-weights/route';
import { registerAdmin, grantRole } from '@/app/api/v1/admin/admin-rbac-test-support';
import {
  adminWithRole as moderationAdmin,
  initiateApproveExecute,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
} from '@/lib/moderation/moderation-test-support';
import { isDatabaseReachable } from './audit-test-support';

const dbReachable = await isDatabaseReachable();

interface Row {
  event_type: string;
  actor_type: string;
  actor_user_id: string;
  actor_roles: string[];
  resource: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before_value: unknown;
  after_value: unknown;
  approval_ref: string | null;
  approval_chain: unknown;
  correlation_id: string | null;
}

async function rowsWhere(condition: ReturnType<typeof sql>): Promise<Row[]> {
  return queryRows<Row>(
    getDb(),
    sql`SELECT event_type, actor_type, actor_user_id, actor_roles, resource, action, target_type, target_id, reason,
               before_value, after_value, approval_ref, approval_chain, correlation_id
          FROM audit_logs WHERE ${condition} ORDER BY created_at, id`,
  );
}

/**
 * Spec 039 AC-5 / §2.2 — earlier specs' audit obligations, exercised through their OWN code paths,
 * each producing a retrievable `audit_logs` row through the shared mechanism. Spec 023 AC-9, 025
 * AC-5, 029 AC-8, 030 AC-3, 031 AC-3 and 032 AC-4/6 are exercised end to end by their own re-pointed
 * suites (X-6), which now assert against `audit_logs`.
 */
describe.skipIf(!dbReachable)('earlier audit obligations reach audit_logs (spec 039 AC-5)', { timeout: 240_000 }, () => {
  beforeEach(() => resetRateLimitState());

  it('spec 009 AC-4 / spec 022 — a refund override (refunds/override, high) is audited through its whole approval chain', async () => {
    const initiator = await registerAdmin();
    await grantRole(initiator, 'finance_admin');
    const approver = await registerAdmin();
    await grantRole(approver, 'finance_admin');
    const bookingId = randomUUID();

    // Exactly the call `lib/refunds/override.ts` makes before any money moves.
    const initiated = await authorizeAndInitiate({
      userId: initiator.userId,
      resource: 'refunds',
      action: 'override',
      targetType: 'booking',
      targetId: bookingId,
      reason: 'Customer was charged twice',
    });
    const adminActionId = (initiated as { adminActionId: string }).adminActionId;
    await decideAction({ approverUserId: approver.userId, adminActionId, decision: 'approved' });
    await executeApprovedAction(adminActionId, initiator.userId);

    const rows = await rowsWhere(sql`resource = 'refunds' AND target_id = ${bookingId}`);
    expect(rows.map((r) => r.event_type)).toEqual(['admin_rbac.action_created', 'admin_rbac.action_approved', 'admin_rbac.action_executed']);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_type: 'admin',
        actor_roles: ['finance_admin'],
        action: 'override',
        target_type: 'booking',
        reason: 'Customer was charged twice',
        approval_ref: adminActionId,
      });
    }
    expect(rows[1]!.actor_user_id).toBe(approver.userId);
    expect(rows[1]!.approval_chain).toMatchObject({ decision: 'approved', initiatedBy: initiator.adminProfileId, decidedBy: approver.adminProfileId });
  });

  it('spec 009 AC-5 — a permission change (role assignment and revocation) is audited', async () => {
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();

    await assignRole(superAdmin.userId, target.userId, 'support_admin');
    const rows = await rowsWhere(sql`resource = 'admin_rbac.role' AND actor_user_id = ${superAdmin.userId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'admin_rbac.role_assigned', actor_type: 'admin', actor_roles: ['super_admin'] });
  });

  it('spec 037 AC-5 / spec 017 — a matching-weights change is audited with before and after, linked to its request', async () => {
    const admin = await registerAdmin();
    await grantRole(admin, 'operations_admin');
    const suffix = randomUUID().slice(0, 8);
    const [category] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO categories (name, slug) VALUES (${`Audit39 ${suffix}`}, ${`audit39-${suffix}`}) RETURNING id`,
    );
    const [service] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO services (category_id, name, slug) VALUES (${category!.id}, ${`Audit39 Service ${suffix}`}, ${`audit39-service-${suffix}`}) RETURNING id`,
    );
    const custom = { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 };
    const base = authenticatedRequest(`http://localhost/api/v1/admin/services/${service!.id}/matching-weights`, admin.sessionId, admin.csrfToken, {
      method: 'PATCH',
      body: { weights: custom, poolSize: 25 },
    });
    const headers = new Headers(base.headers);
    headers.set('x-correlation-id', `weights-${suffix}`);
    expect((await PATCH_WEIGHTS(new Request(base, { headers }))).status).toBe(200);

    const [row] = await rowsWhere(sql`event_type = 'admin_rbac.matching_weights_updated' AND target_id = ${service!.id}`);
    expect(row).toMatchObject({ actor_type: 'admin', actor_roles: ['operations_admin'], resource: 'matching.config', target_type: 'service', correlation_id: `weights-${suffix}` });
    expect(row!.after_value).toMatchObject({ weights: custom, poolSize: 25 });
    expect(row!.before_value).not.toBeNull();
  });

  describe('spec 038 AC-4 — moderation', () => {
    beforeEach(() => useModerationIntegration());
    afterEach(() => resetModerationForTests());

    it('a ban is audited with lifecycle before/after and the spec 009 approval reference', async () => {
      const initiator = await moderationAdmin();
      const approver = await moderationAdmin();
      const target = await seedCustomer();
      const action = await initiateApproveExecute(initiator, approver, { actionType: 'ban', scope: 'account', targetUserId: target.userId });

      const [executed] = await rowsWhere(sql`event_type = 'moderation.action_executed' AND target_id = ${action.id}`);
      expect(executed).toMatchObject({
        actor_type: 'admin',
        actor_user_id: initiator.userId,
        resource: 'moderation',
        target_type: 'moderation_action',
        reason: 'Test reason for moderation.',
        approval_ref: action.adminActionId,
      });
      expect(JSON.stringify(executed!.before_value)).toContain('active');
      expect(JSON.stringify(executed!.after_value)).toContain('banned');
      expect(executed!.approval_chain).toMatchObject({ adminActionId: action.adminActionId, decision: 'approved' });
    });
  });
});
