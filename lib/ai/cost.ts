/**
 * Spec 033 §3.7/AC-6 — cost estimation and the cost alerts.
 *
 * Cost is DERIVED, never stored: `tokens × AI_COST_PER_1K_TOKENS_MINOR_UNITS / 1000`. The rate
 * defaults to `0` because no provider is priced yet, so cost reads `0` rather than a guess — and
 * `AI_DAILY_TOKEN_ALERT` is the alert that stays meaningful meanwhile. Setting the real rate later
 * corrects history retroactively.
 *
 * Alerts are evaluated by the hourly sweep, not on the request path: the hot path stays a single
 * insert, and thresholds are checked deterministically against whole UTC periods.
 */
import { and, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiUsageEvents, securityEvents } from '@/lib/db/schema';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import type { AiCostAlertThresholds } from '@/lib/types/ai';
import {
  aiCostCurrencyCode,
  aiCostPer1kTokensMinorUnits,
  aiDailyCostAlertMinorUnits,
  aiDailyTokenAlert,
  aiMonthlyCostAlertMinorUnits,
} from './config';

export const AI_COST_ALERT_EVENT_TYPE = 'ai.cost_alert';

/** Integer minor units — money never touches a float (master spec §132.5). */
export function estimateAiCostMinorUnits(tokens: number): number {
  return Math.round((tokens * aiCostPer1kTokensMinorUnits()) / 1000);
}

export function aiCostAlertThresholds(): AiCostAlertThresholds {
  return {
    dailyMinorUnits: aiDailyCostAlertMinorUnits(),
    monthlyMinorUnits: aiMonthlyCostAlertMinorUnits(),
    dailyTokens: aiDailyTokenAlert(),
  };
}

export type AiCostAlertScope = 'daily_cost' | 'monthly_cost' | 'daily_tokens';

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function tokensBetween(from: Date, to: Date): Promise<number> {
  const [row] = await getDb()
    .select({ tokens: sql<number>`coalesce(sum(${aiUsageEvents.tokensUsed}), 0)::int` })
    .from(aiUsageEvents)
    .where(and(gte(aiUsageEvents.createdAt, from), lt(aiUsageEvents.createdAt, to)));
  return row?.tokens ?? 0;
}

/** One alert per scope per period — the `periodStart` in the metadata is what makes it unique. */
async function alreadyAlerted(scope: AiCostAlertScope, periodStart: Date): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: securityEvents.id })
    .from(securityEvents)
    .where(
      sql`${securityEvents.eventType} = ${AI_COST_ALERT_EVENT_TYPE}
          and ${securityEvents.metadata}->>'scope' = ${scope}
          and ${securityEvents.metadata}->>'periodStart' = ${periodStart.toISOString()}`,
    )
    .limit(1);
  return row !== undefined;
}

async function emit(
  scope: AiCostAlertScope,
  periodStart: Date,
  observed: number,
  threshold: number,
  unit: 'minor_units' | 'tokens',
): Promise<boolean> {
  if (await alreadyAlerted(scope, periodStart)) return false;
  await recordSecurityEvent({
    eventType: AI_COST_ALERT_EVENT_TYPE,
    severity: 'warning',
    metadata: {
      scope,
      periodStart: periodStart.toISOString(),
      observed,
      threshold,
      unit,
      ...(unit === 'minor_units' ? { currencyCode: aiCostCurrencyCode() } : {}),
    },
  });
  return true;
}

/**
 * Evaluates the three thresholds for the current UTC day and calendar month, emitting at most one
 * `ai.cost_alert` per scope per period. An alert is information for Finance — it changes no limit
 * and blocks nothing; `AI_ASSISTANT_ENABLED=false` is the kill switch if spend must actually stop.
 */
export async function evaluateAiCostAlerts(now = new Date()): Promise<{ emitted: AiCostAlertScope[] }> {
  const emitted: AiCostAlertScope[] = [];
  const thresholds = aiCostAlertThresholds();

  const dayStart = utcDayStart(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayTokens = await tokensBetween(dayStart, dayEnd);
  const dayCost = estimateAiCostMinorUnits(dayTokens);

  if (dayCost > thresholds.dailyMinorUnits && (await emit('daily_cost', dayStart, dayCost, thresholds.dailyMinorUnits, 'minor_units'))) {
    emitted.push('daily_cost');
  }
  if (dayTokens > thresholds.dailyTokens && (await emit('daily_tokens', dayStart, dayTokens, thresholds.dailyTokens, 'tokens'))) {
    emitted.push('daily_tokens');
  }

  const monthStart = utcMonthStart(now);
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const monthCost = estimateAiCostMinorUnits(await tokensBetween(monthStart, monthEnd));
  if (
    monthCost > thresholds.monthlyMinorUnits &&
    (await emit('monthly_cost', monthStart, monthCost, thresholds.monthlyMinorUnits, 'minor_units'))
  ) {
    emitted.push('monthly_cost');
  }

  return { emitted };
}
