import { AUDIT_EVENTS } from '@/lib/audit/audit-test-support';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { executeModerationAction, executeReversal, requestReversal } from './actions';
import { decideModerationAppeal, fileModerationAppeal } from './appeals';
import { recordFraudSignal, triageFraudSignal } from './fraud-signals';
import { queryRows } from '@/lib/offers/db';
import {
  adminWithRole,
  approve,
  auditEvents,
  initiate,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 AC-4 — every operation is audited through spec 009's existing helper. */
describe.skipIf(!dbReachable)('moderation audit (spec 038 AC-4)', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('an immediate action records actor, roles, reason, target and before/after lifecycle', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const { action } = await initiate(admin, { actionType: 'restriction', scope: 'account', targetUserId: target.userId, reason: 'Abusive messages.' });
    const [event] = await auditEvents('moderation.action_applied', action.id);
    expect(event!.user_id).toBe(admin.userId);
    expect(event!.metadata).toMatchObject({
      actorRoles: ['trust_safety_admin'],
      reason: 'Abusive messages.',
      targetType: 'moderation_action',
      targetId: action.id,
      before: { userLifecycleStatus: 'active' },
      after: { userLifecycleStatus: 'restricted', targetUserId: target.userId },
    });
    // Spec 009's own permit event is written too.
    const [permit] = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM ${AUDIT_EVENTS} WHERE event_type = 'admin_rbac.action_permitted' AND metadata->>'targetId' = ${action.id}`,
    );
    expect(permit!.n).toBe(1);
  });

  it('a four-eyes action carries the full approval chain on execution', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'suspension', scope: 'account', targetUserId: target.userId });
    expect(await auditEvents('moderation.action_pending', action.id)).toHaveLength(1);
    await approve(b, action.adminActionId!);
    await executeModerationAction({ adminUserId: a.userId, actionId: action.id, correlationId: 'corr-1' });

    const [executed] = await auditEvents('moderation.action_executed', action.id);
    expect(executed!.metadata.approvalChain).toMatchObject({
      adminActionId: action.adminActionId,
      initiatedBy: a.adminProfileId,
      decidedBy: b.adminProfileId,
      decision: 'approved',
    });
    expect(executed!.metadata.correlationId).toBe('corr-1');
    expect((await auditEvents('moderation.sessions_revoked', target.userId)).length).toBe(1);
  });

  it('reversal, appeals and signal triage are audited; the appellant carries no admin role', async () => {
    const [a, b, c] = [await adminWithRole(), await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const { action } = await initiate(a, { actionType: 'warning', scope: 'account', targetUserId: target.userId });
    const { appeal } = await fileModerationAppeal({ userId: target.userId, actionId: action.id, statement: 'Unfair.', idempotencyKey: randomUUID(), fingerprint: 'f', correlationId: null });
    const [filed] = await auditEvents('moderation.appeal_filed', action.id);
    expect(filed!.metadata.actorRoles).toEqual([]);
    await decideModerationAppeal({ adminUserId: c.userId, appealId: appeal.id, decision: 'denied', reason: 'Warning stands.', correlationId: null });
    expect(await auditEvents('moderation.appeal_decided', appeal.id)).toHaveLength(1);

    const requested = await requestReversal({ adminUserId: a.userId, actionId: action.id, reason: 'Reconsidered.', correlationId: null });
    expect(await auditEvents('moderation.reversal_requested', action.id)).toHaveLength(1);
    await approve(b, requested.reversalAdminActionId!);
    await executeReversal({ adminUserId: a.userId, actionId: action.id, correlationId: null });
    expect(await auditEvents('moderation.action_reversed', action.id)).toHaveLength(1);

    await recordFraudSignal({ targetUserId: target.userId, source: 'rule_based', ruleKey: 'audit_rule', observedCount: 2, threshold: 1, windowDays: 1 });
    const [signal] = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM fraud_signals WHERE target_user_id = ${target.userId} AND rule_key = 'audit_rule'`);
    await triageFraudSignal({ adminUserId: a.userId, signalId: signal!.id, to: 'dismissed', expectedStatus: 'pending_review', reason: 'Noise.', correlationId: null });
    expect(await auditEvents('fraud_signal.dismissed', signal!.id)).toHaveLength(1);
  });
});
