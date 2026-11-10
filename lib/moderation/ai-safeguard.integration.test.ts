import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { AiFraudSignalsDisabledError, recordFraudSignal } from './fraud-signals';
import { runFraudSignalSweep } from './rules';
import { executeModerationAction } from './actions';
import {
  adminWithRole,
  initiate,
  isDatabaseReachable,
  resetModerationForTests,
  seedCustomer,
  useModerationIntegration,
  userStatus,
} from './moderation-test-support';

const dbReachable = await isDatabaseReachable();
const FLAG = process.env.AI_FRAUD_SIGNALS_ENABLED;

afterAll(async () => {
  await getPool().end();
});

async function countActionsFor(userId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM moderation_actions WHERE target_user_id = ${userId}`);
  return row!.n;
}

/** Spec 038 AC-3 — AI and rule signals create review items ONLY; a human is always required. */
describe.skipIf(!dbReachable)('AI / human-in-the-loop safeguard (spec 038 AC-3)', { timeout: 120_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => {
    resetModerationForTests();
    if (FLAG === undefined) delete process.env.AI_FRAUD_SIGNALS_ENABLED;
    else process.env.AI_FRAUD_SIGNALS_ENABLED = FLAG;
  });

  it('an ai_assisted signal is refused while the flag is off, and nothing is written', async () => {
    delete process.env.AI_FRAUD_SIGNALS_ENABLED;
    const target = await seedCustomer();
    await expect(
      recordFraudSignal({ targetUserId: target.userId, source: 'ai_assisted', ruleKey: 'ai_anomaly', observedCount: 1, threshold: 1, windowDays: 1 }),
    ).rejects.toBeInstanceOf(AiFraudSignalsDisabledError);
    const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM fraud_signals WHERE target_user_id = ${target.userId}`);
    expect(row!.n).toBe(0);
  });

  it('with the flag on, an ai_assisted signal is ONLY a pending_review item: no action, no lifecycle change', async () => {
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'true';
    const target = await seedCustomer();
    expect(
      await recordFraudSignal({ targetUserId: target.userId, source: 'ai_assisted', ruleKey: 'ai_anomaly', observedCount: 9, threshold: 1, windowDays: 1 }),
    ).toBe(true);
    const [signal] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM fraud_signals WHERE target_user_id = ${target.userId}`);
    expect(signal!.status).toBe('pending_review');
    expect(await countActionsFor(target.userId)).toBe(0);
    expect(await userStatus(target.userId)).toBe('active');
  });

  it('the rule sweep creates signals only — even for a user who meets a rule, nothing is enforced', async () => {
    const target = await seedCustomer();
    process.env.FRAUD_RULE_R1_THRESHOLD = '1';
    process.env.FRAUD_RULE_R1_WINDOW_DAYS = '30';
    try {
      const reporter = await seedCustomer();
      await getDb().execute(sql`
        INSERT INTO safety_reports (reporter_user_id, target_user_id, category, description, idempotency_key, idempotency_fingerprint)
        VALUES (${reporter.userId}, ${target.userId}, 'harassment', 'They shouted at me repeatedly during the job.', gen_random_uuid()::text, 'fp')`);
      const result = await runFraudSignalSweep();
      expect(result.rulesActive).toContain('repeated_safety_reports');
      expect(await countActionsFor(target.userId)).toBe(0);
      expect(await userStatus(target.userId)).toBe('active');
    } finally {
      delete process.env.FRAUD_RULE_R1_THRESHOLD;
      delete process.env.FRAUD_RULE_R1_WINDOW_DAYS;
    }
  });

  it('a moderation action without a human initiator is unrepresentable at the database', async () => {
    const target = await seedCustomer();
    await expect(
      getDb().execute(sql`
        INSERT INTO moderation_actions (action_type, scope, target_user_id, risk_tier, status, reason)
        VALUES ('ban', 'account', ${target.userId}, 'low', 'active', 'AI said so')`),
    ).rejects.toThrow();
  });

  it('a ban acting on a signal still needs a SECOND admin before anything happens', async () => {
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'true';
    const admin = await adminWithRole();
    const target = await seedCustomer();
    await recordFraudSignal({ targetUserId: target.userId, source: 'ai_assisted', ruleKey: 'ai_anomaly', observedCount: 5, threshold: 1, windowDays: 1 });
    const [signal] = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM fraud_signals WHERE target_user_id = ${target.userId}`);

    const { action, outcome } = await initiate(admin, { actionType: 'ban', scope: 'account', targetUserId: target.userId, originFraudSignalId: signal!.id });
    expect(outcome).toBe('pending_approval');
    expect(await userStatus(target.userId)).toBe('active');
    await expect(executeModerationAction({ adminUserId: admin.userId, actionId: action.id, correlationId: null })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(await userStatus(target.userId)).toBe('active');
  });
});
