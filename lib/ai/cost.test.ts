import { afterEach, describe, expect, it } from 'vitest';
import { aiCostAlertThresholds, estimateAiCostMinorUnits } from './cost';

/** Spec 033 §3.7/AC-6 — cost is derived from tokens in integer minor units, never stored. */
describe('lib/ai/cost estimation (spec 033 AC-6)', () => {
  const savedRate = process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS;

  afterEach(() => {
    if (savedRate === undefined) delete process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS;
    else process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = savedRate;
  });

  it('reads 0 while no provider is priced, rather than guessing a figure', () => {
    delete process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS;
    expect(estimateAiCostMinorUnits(1_000_000)).toBe(0);
  });

  it('derives cost from the configured rate, so setting it later corrects history', () => {
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '250';
    expect(estimateAiCostMinorUnits(0)).toBe(0);
    expect(estimateAiCostMinorUnits(1_000)).toBe(250);
    expect(estimateAiCostMinorUnits(10_000)).toBe(2_500);
  });

  it('always yields an integer number of minor units — money never touches a float', () => {
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '7';
    for (const tokens of [1, 3, 17, 999, 1_234]) {
      expect(Number.isInteger(estimateAiCostMinorUnits(tokens))).toBe(true);
    }
  });

  it('exposes the finalized alert thresholds', () => {
    expect(aiCostAlertThresholds()).toEqual({
      dailyMinorUnits: 500_000,
      monthlyMinorUnits: 10_000_000,
      dailyTokens: 500_000,
    });
  });
});
