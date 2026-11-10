import { afterEach, describe, expect, it } from 'vitest';
import * as config from './config';
import { isAiAssistantEnabled } from './feature-flags';

const KEYS = [
  'AI_REQUEST_TIMEOUT_MS',
  'AI_MAX_TOKENS_PER_REQUEST',
  'AI_MAX_REQUESTS_PER_DAY',
  'AI_MAX_TOKENS_PER_DAY',
  'AI_GUEST_MAX_REQUESTS_PER_DAY',
  'AI_GUEST_MAX_TOKENS_PER_DAY',
  'AI_CACHE_TTL_SECONDS',
  'AI_CACHE_MAX_ENTRIES',
  'AI_COST_PER_1K_TOKENS_MINOR_UNITS',
  'AI_COST_CURRENCY_CODE',
  'AI_DAILY_COST_ALERT_MINOR_UNITS',
  'AI_MONTHLY_COST_ALERT_MINOR_UNITS',
  'AI_DAILY_TOKEN_ALERT',
  'AI_ABUSE_REQUESTS_PER_HOUR',
  'AI_ABUSE_REJECTIONS_PER_DAY',
  'AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR',
  'AI_USAGE_RETENTION_DAYS',
  'AI_ASSISTANT_ENABLED',
] as const;

/** Spec 033 §3.7 — the finalized defaults, and the "malformed falls back, never fails" posture. */
describe('lib/ai/config (spec 033 §3.7)', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the finalized defaults when unset', () => {
    for (const key of KEYS) delete process.env[key];
    expect(config.aiRequestTimeoutMs()).toBe(15_000);
    expect(config.aiMaxTokensPerRequest()).toBe(2_000);
    expect(config.aiMaxRequestsPerDay()).toBe(200);
    expect(config.aiMaxTokensPerDay()).toBe(100_000);
    expect(config.aiGuestMaxRequestsPerDay()).toBe(40);
    expect(config.aiGuestMaxTokensPerDay()).toBe(20_000);
    expect(config.aiCacheTtlSeconds()).toBe(3_600);
    expect(config.aiCacheMaxEntries()).toBe(1_000);
    expect(config.aiCostPer1kTokensMinorUnits()).toBe(0);
    expect(config.aiCostCurrencyCode()).toBe('PKR');
    expect(config.aiDailyCostAlertMinorUnits()).toBe(500_000);
    expect(config.aiMonthlyCostAlertMinorUnits()).toBe(10_000_000);
    expect(config.aiDailyTokenAlert()).toBe(500_000);
    expect(config.aiAbuseRequestsPerHour()).toBe(120);
    expect(config.aiAbuseRejectionsPerDay()).toBe(20);
    expect(config.aiAbuseIdenticalInputsPerHour()).toBe(50);
    expect(config.aiUsageRetentionDays()).toBe(90);
    expect(config.AI_ABUSE_TOKEN_BURN_FRACTION).toBe(0.8);
    expect(isAiAssistantEnabled()).toBe(true);
  });

  it('honours a valid override immediately — read fresh, never memoised', () => {
    process.env.AI_MAX_TOKENS_PER_DAY = '7';
    expect(config.aiMaxTokensPerDay()).toBe(7);
    process.env.AI_MAX_TOKENS_PER_DAY = '9';
    expect(config.aiMaxTokensPerDay()).toBe(9);
  });

  it('falls back to the default for a malformed value rather than failing an AI request', () => {
    for (const bad of ['', '   ', 'lots', '-5', '1.5', 'NaN']) {
      process.env.AI_MAX_REQUESTS_PER_DAY = bad;
      expect(config.aiMaxRequestsPerDay()).toBe(200);
    }
    process.env.AI_COST_CURRENCY_CODE = 'rupees';
    expect(config.aiCostCurrencyCode()).toBe('PKR');
  });

  it('a cost rate of 0 is a legitimate configured value, not a malformed one', () => {
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '0';
    expect(config.aiCostPer1kTokensMinorUnits()).toBe(0);
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '250';
    expect(config.aiCostPer1kTokensMinorUnits()).toBe(250);
  });

  it('the ai-assistant kill switch is off only for the exact string "false"', () => {
    process.env.AI_ASSISTANT_ENABLED = 'false';
    expect(isAiAssistantEnabled()).toBe(false);
    for (const value of ['true', '', 'FALSE', '0']) {
      process.env.AI_ASSISTANT_ENABLED = value;
      expect(isAiAssistantEnabled()).toBe(true);
    }
  });
});
