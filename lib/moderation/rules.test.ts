import { afterEach, describe, expect, it } from 'vitest';
import { activeRules } from './rules';
import { isAiFraudSignalsEnabled } from './flags';

const KEYS = ['FRAUD_RULE_R1_THRESHOLD', 'FRAUD_RULE_R1_WINDOW_DAYS', 'FRAUD_RULE_R2_THRESHOLD', 'FRAUD_RULE_R2_WINDOW_DAYS', 'AI_FRAUD_SIGNALS_ENABLED'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Spec 038 §3.6 — no threshold is invented: an unset or invalid pair makes the rule inactive. */
describe('fraud rule configuration (spec 038 §3.6)', () => {
  it('no rule is active when nothing is configured', () => {
    for (const key of KEYS) delete process.env[key];
    expect(activeRules()).toEqual([]);
  });

  it('a rule is active only when BOTH its threshold and window are positive integers', () => {
    process.env.FRAUD_RULE_R1_THRESHOLD = '3';
    process.env.FRAUD_RULE_R1_WINDOW_DAYS = '30';
    process.env.FRAUD_RULE_R2_THRESHOLD = '2';
    delete process.env.FRAUD_RULE_R2_WINDOW_DAYS;
    expect(activeRules()).toEqual([{ key: 'repeated_safety_reports', threshold: 3, windowDays: 30 }]);
  });

  it('zero, negative, fractional and non-numeric values leave the rule inactive', () => {
    for (const bad of ['0', '-1', '2.5', 'abc', ' ']) {
      process.env.FRAUD_RULE_R2_THRESHOLD = bad;
      process.env.FRAUD_RULE_R2_WINDOW_DAYS = '7';
      delete process.env.FRAUD_RULE_R1_THRESHOLD;
      expect(activeRules()).toEqual([]);
    }
  });

  it('the AI flag is off unless it is exactly "true"', () => {
    delete process.env.AI_FRAUD_SIGNALS_ENABLED;
    expect(isAiFraudSignalsEnabled()).toBe(false);
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'TRUE';
    expect(isAiFraudSignalsEnabled()).toBe(false);
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'true';
    expect(isAiFraudSignalsEnabled()).toBe(true);
  });
});
