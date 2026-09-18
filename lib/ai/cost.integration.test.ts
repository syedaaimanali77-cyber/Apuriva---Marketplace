import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_COST_ALERT_EVENT_TYPE, evaluateAiCostAlerts } from './cost';
import { createAiUser, isDatabaseReachable, resetAiState, securityEventsOfType, seedUsage } from './ai-test-support';
import type { AiSubject } from './types';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 033 AC-6 — the cost/volume alerts.
 *
 * The thresholds are evaluated over WHOLE UTC PERIODS of the shared `*_test` database, so these
 * tests set the thresholds relative to what is already there rather than assuming an empty table:
 * each one reads the current period's totals first, then sets a threshold just below or just above
 * them. That is also closer to how an operator actually tunes a threshold.
 */
describe.skipIf(!dbReachable)('AI cost alerts (spec 033 AC-6, integration)', () => {
  const KEYS = [
    'AI_COST_PER_1K_TOKENS_MINOR_UNITS',
    'AI_DAILY_COST_ALERT_MINOR_UNITS',
    'AI_MONTHLY_COST_ALERT_MINOR_UNITS',
    'AI_DAILY_TOKEN_ALERT',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  /** Puts every threshold far out of reach, so a test only trips the one it sets deliberately. */
  function silenceAllAlerts(): void {
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '0';
    process.env.AI_DAILY_COST_ALERT_MINOR_UNITS = String(Number.MAX_SAFE_INTEGER);
    process.env.AI_MONTHLY_COST_ALERT_MINOR_UNITS = String(Number.MAX_SAFE_INTEGER);
    process.env.AI_DAILY_TOKEN_ALERT = String(Number.MAX_SAFE_INTEGER);
  }

  beforeEach(() => {
    resetAiState();
    silenceAllAlerts();
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function seedTokensToday(tokens: number): Promise<void> {
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 1, tokensUsed: tokens });
  }

  it('emits no alert while every threshold is above the period total', async () => {
    const since = new Date();
    await seedTokensToday(1_000);
    expect(await evaluateAiCostAlerts()).toEqual({ emitted: [] });
    expect(await securityEventsOfType(AI_COST_ALERT_EVENT_TYPE, since)).toEqual([]);
  });

  it('emits a daily token alert once the day total passes the threshold, and only once per day', async () => {
    const since = new Date();
    await seedTokensToday(5_000);
    // Set the threshold just under whatever today already holds, so the crossing is deliberate.
    process.env.AI_DAILY_TOKEN_ALERT = '1';

    const first = await evaluateAiCostAlerts();
    expect(first.emitted).toContain('daily_tokens');

    const events = (await securityEventsOfType(AI_COST_ALERT_EVENT_TYPE, since)).filter(
      (event) => event.metadata.scope === 'daily_tokens',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe('warning');
    expect(events[0]!.metadata).toMatchObject({ scope: 'daily_tokens', threshold: 1, unit: 'tokens' });
    expect(Number(events[0]!.metadata.observed)).toBeGreaterThanOrEqual(5_000);

    // Repeated hourly passes inside the same UTC day add nothing.
    for (let i = 0; i < 3; i += 1) {
      expect((await evaluateAiCostAlerts()).emitted).not.toContain('daily_tokens');
    }
    expect(
      (await securityEventsOfType(AI_COST_ALERT_EVENT_TYPE, since)).filter((e) => e.metadata.scope === 'daily_tokens'),
    ).toHaveLength(1);
  });

  it('emits daily and monthly cost alerts, each carrying the currency and its own period', async () => {
    const since = new Date();
    await seedTokensToday(10_000);
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '100';
    process.env.AI_DAILY_COST_ALERT_MINOR_UNITS = '1';
    process.env.AI_MONTHLY_COST_ALERT_MINOR_UNITS = '1';

    const { emitted } = await evaluateAiCostAlerts();
    expect(emitted).toContain('daily_cost');
    expect(emitted).toContain('monthly_cost');

    const events = await securityEventsOfType(AI_COST_ALERT_EVENT_TYPE, since);
    const daily = events.find((event) => event.metadata.scope === 'daily_cost')!;
    const monthly = events.find((event) => event.metadata.scope === 'monthly_cost')!;
    expect(daily.metadata).toMatchObject({ unit: 'minor_units', currencyCode: 'PKR' });
    expect(monthly.metadata).toMatchObject({ unit: 'minor_units', currencyCode: 'PKR' });
    // Different periods, so a daily alert never silences the monthly one.
    expect(daily.metadata.periodStart).not.toBe(monthly.metadata.periodStart);
    expect(Number(monthly.metadata.observed)).toBeGreaterThanOrEqual(Number(daily.metadata.observed));
  });

  it('stays silent while the cost rate is 0, however many tokens are spent', async () => {
    const since = new Date();
    await seedTokensToday(50_000);
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '0';
    process.env.AI_DAILY_COST_ALERT_MINOR_UNITS = '1';
    process.env.AI_MONTHLY_COST_ALERT_MINOR_UNITS = '1';

    const { emitted } = await evaluateAiCostAlerts();
    expect(emitted).not.toContain('daily_cost');
    expect(emitted).not.toContain('monthly_cost');
    expect(
      (await securityEventsOfType(AI_COST_ALERT_EVENT_TYPE, since)).filter((e) =>
        String(e.metadata.scope).endsWith('_cost'),
      ),
    ).toEqual([]);
  });
});
