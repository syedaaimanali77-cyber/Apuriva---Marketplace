import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { listFraudSignals, recordFraudSignal, triageFraudSignal } from './fraud-signals';
import { runFraudSignalSweep } from './rules';
import {
  adminWithRole,
  initiate,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();
const RULE_KEYS = ['FRAUD_RULE_R1_THRESHOLD', 'FRAUD_RULE_R1_WINDOW_DAYS', 'FRAUD_RULE_R2_THRESHOLD', 'FRAUD_RULE_R2_WINDOW_DAYS'];

afterAll(async () => {
  await getPool().end();
});

async function signalFor(userId: string, ruleKey = 'test_rule') {
  await recordFraudSignal({ targetUserId: userId, source: 'rule_based', ruleKey, observedCount: 3, threshold: 2, windowDays: 30 });
  const [row] = await queryRows<{ id: string; status: string }>(
    getDb(),
    sql`SELECT id, status FROM fraud_signals WHERE target_user_id = ${userId} AND rule_key = ${ruleKey} ORDER BY created_at DESC LIMIT 1`,
  );
  return row!;
}

/** Spec 038 §3.6 — the review queue: record, dedupe, triage, act. */
describe.skipIf(!dbReachable)('fraud signals (spec 038 §3.6)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => {
    resetModerationForTests();
    for (const key of RULE_KEYS) delete process.env[key];
  });

  it('dedupes: one open signal per (rule, target)', async () => {
    const target = await seedCustomer();
    expect(await recordFraudSignal({ targetUserId: target.userId, source: 'rule_based', ruleKey: 'dup', observedCount: 2, threshold: 2, windowDays: 7 })).toBe(true);
    expect(await recordFraudSignal({ targetUserId: target.userId, source: 'rule_based', ruleKey: 'dup', observedCount: 3, threshold: 2, windowDays: 7 })).toBe(false);
  });

  it('with no rules configured the sweep runs nothing', async () => {
    for (const key of RULE_KEYS) delete process.env[key];
    expect(await runFraudSignalSweep()).toEqual({ rulesActive: [], signalsCreated: 0 });
  });

  it('R1 flags a user reported by at least THRESHOLD distinct reporters within the window', async () => {
    process.env.FRAUD_RULE_R1_THRESHOLD = '2';
    process.env.FRAUD_RULE_R1_WINDOW_DAYS = '30';
    const target = await seedCustomer();
    for (let i = 0; i < 2; i += 1) {
      const reporter = await seedCustomer();
      await getDb().execute(sql`
        INSERT INTO safety_reports (reporter_user_id, target_user_id, category, description, idempotency_key, idempotency_fingerprint)
        VALUES (${reporter.userId}, ${target.userId}, 'harassment', 'Aggressive and abusive during the visit.', ${randomUUID()}, 'fp')`);
    }
    await runFraudSignalSweep();
    const [signal] = await queryRows<{ observed_count: number; source: string; status: string }>(
      getDb(),
      sql`SELECT observed_count, source, status FROM fraud_signals WHERE target_user_id = ${target.userId} AND rule_key = 'repeated_safety_reports'`,
    );
    expect(signal).toMatchObject({ observed_count: 2, source: 'rule_based', status: 'pending_review' });
  });

  it('R2 is evaluated when configured (reports it active)', async () => {
    process.env.FRAUD_RULE_R2_THRESHOLD = '1';
    process.env.FRAUD_RULE_R2_WINDOW_DAYS = '7';
    const result = await runFraudSignalSweep();
    expect(result.rulesActive).toContain('repeated_no_show_fault');
  });

  it('triage: escalate then dismiss, conditional on expectedStatus, audited with a reason', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const signal = await signalFor(target.userId);

    await expect(
      triageFraudSignal({ adminUserId: admin.userId, signalId: signal.id, to: 'dismissed', expectedStatus: 'escalated', reason: 'x', correlationId: null }),
    ).rejects.toMatchObject({ code: 'FRAUD_SIGNAL_STATUS_CONFLICT', status: 409 });

    const escalated = await triageFraudSignal({ adminUserId: admin.userId, signalId: signal.id, to: 'escalated', expectedStatus: 'pending_review', reason: 'Looks organised.', correlationId: null });
    expect(escalated.status).toBe('escalated');
    expect(escalated.triagedByAdminUserId).toBe(admin.userId);

    await expect(
      triageFraudSignal({ adminUserId: admin.userId, signalId: signal.id, to: 'escalated', expectedStatus: 'escalated', reason: 'again', correlationId: null }),
    ).rejects.toMatchObject({ code: 'FRAUD_SIGNAL_STATUS_CONFLICT' });

    const dismissed = await triageFraudSignal({ adminUserId: admin.userId, signalId: signal.id, to: 'dismissed', expectedStatus: 'escalated', reason: 'False alarm.', correlationId: null });
    expect(dismissed.status).toBe('dismissed');
  });

  it('acting on a signal marks it actioned and links the action; a closed or foreign signal is refused', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const other = await seedCustomer();
    const signal = await signalFor(target.userId, 'act_rule');

    await expect(initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: other.userId, originFraudSignalId: signal.id })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const { action } = await initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: target.userId, originFraudSignalId: signal.id });
    expect(action.originFraudSignalId).toBe(signal.id);
    const { rows } = await listFraudSignals(admin.userId, { targetUserId: target.userId }, { limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({ status: 'actioned', moderationActionId: action.id });

    await expect(initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: target.userId, originFraudSignalId: signal.id })).rejects.toMatchObject({
      code: 'FRAUD_SIGNAL_STATUS_CONFLICT',
    });
    await expect(
      initiate(admin, { actionType: 'warning', scope: 'account', targetUserId: target.userId, originFraudSignalId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('only fraud_signals permissions read or triage the queue', async () => {
    const ops = await adminWithRole('operations_admin');
    await expect(listFraudSignals(ops.userId, {}, { limit: 10, offset: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      triageFraudSignal({ adminUserId: ops.userId, signalId: randomUUID(), to: 'dismissed', expectedStatus: 'pending_review', reason: 'x', correlationId: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
