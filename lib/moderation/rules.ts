/**
 * Spec 038 §3.6 — the rule-based fraud MVP, run by `GET /api/v1/cron/fraud-signal-sweep`.
 *
 * READ-ONLY over other specs' tables (spec 030's `safety_reports`, spec 023's `no_show_reports`);
 * the only write is `recordFraudSignal()`. No threshold is invented: each rule reads its own pair
 * of environment variables, and a rule whose pair is unset or invalid is INACTIVE. Trust & Safety
 * configures the values at deployment (`.env.example`).
 *
 * Like `./fraud-signals`, this module imports neither `./actions` nor `./lifecycle`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { recordFraudSignal } from './fraud-signals';

export type FraudRuleKey = 'repeated_safety_reports' | 'repeated_no_show_fault';

export interface RuleConfig {
  key: FraudRuleKey;
  threshold: number;
  windowDays: number;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function pair(key: FraudRuleKey, threshold: string | undefined, windowDays: string | undefined): RuleConfig | null {
  const t = positiveInt(threshold);
  const w = positiveInt(windowDays);
  return t !== null && w !== null ? { key, threshold: t, windowDays: w } : null;
}

/** The ACTIVE rules. Each variable is read by its literal name so `npm run check:env` sees it. */
export function activeRules(): RuleConfig[] {
  return [
    pair('repeated_safety_reports', process.env.FRAUD_RULE_R1_THRESHOLD, process.env.FRAUD_RULE_R1_WINDOW_DAYS),
    pair('repeated_no_show_fault', process.env.FRAUD_RULE_R2_THRESHOLD, process.env.FRAUD_RULE_R2_WINDOW_DAYS),
  ].filter((rule): rule is RuleConfig => rule !== null);
}

/** R1 — distinct reporters against one target within the window. */
async function evaluateR1(rule: RuleConfig): Promise<{ targetUserId: string; observed: number }[]> {
  const rows = await queryRows<{ target_user_id: string; observed: number }>(
    getDb(),
    sql`SELECT target_user_id, count(DISTINCT reporter_user_id)::int AS observed
          FROM safety_reports
         WHERE created_at >= clock_timestamp() - make_interval(days => ${rule.windowDays})
         GROUP BY target_user_id
        HAVING count(DISTINCT reporter_user_id) >= ${rule.threshold}`,
  );
  return rows.map((r) => ({ targetUserId: r.target_user_id, observed: r.observed }));
}

/** R2 — confirmed no-show faults, attributed to the party the outcome names, within the window. */
async function evaluateR2(rule: RuleConfig): Promise<{ targetUserId: string; observed: number }[]> {
  const rows = await queryRows<{ target_user_id: string; observed: number }>(
    getDb(),
    sql`SELECT attributed.user_id AS target_user_id, count(*)::int AS observed
          FROM (
            SELECT CASE n.outcome WHEN 'no_show_confirmed_customer' THEN cp.user_id ELSE pp.user_id END AS user_id
              FROM no_show_reports n
              JOIN bookings b ON b.id = n.booking_id
              JOIN customer_profiles cp ON cp.id = b.customer_profile_id
              JOIN provider_profiles pp ON pp.id = b.provider_profile_id
             WHERE n.outcome IN ('no_show_confirmed_customer', 'no_show_confirmed_provider')
               AND n.resolved_at >= clock_timestamp() - make_interval(days => ${rule.windowDays})
          ) attributed
         GROUP BY attributed.user_id
        HAVING count(*) >= ${rule.threshold}`,
  );
  return rows.map((r) => ({ targetUserId: r.target_user_id, observed: r.observed }));
}

export interface FraudSignalSweepResult {
  rulesActive: FraudRuleKey[];
  signalsCreated: number;
}

export async function runFraudSignalSweep(): Promise<FraudSignalSweepResult> {
  const rules = activeRules();
  let signalsCreated = 0;
  for (const rule of rules) {
    const hits = rule.key === 'repeated_safety_reports' ? await evaluateR1(rule) : await evaluateR2(rule);
    for (const hit of hits) {
      const created = await recordFraudSignal({
        targetUserId: hit.targetUserId,
        source: 'rule_based',
        ruleKey: rule.key,
        observedCount: hit.observed,
        threshold: rule.threshold,
        windowDays: rule.windowDays,
      });
      if (created) signalsCreated += 1;
    }
  }
  console.log(JSON.stringify({ event: 'fraud_signal.sweep_completed', rulesActive: rules.map((r) => r.key), signalsCreated }));
  return { rulesActive: rules.map((r) => r.key), signalsCreated };
}
