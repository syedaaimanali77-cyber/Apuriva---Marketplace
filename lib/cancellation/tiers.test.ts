import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULT_CANCELLATION_CONFIG } from './policy-config';
import { computeCancellationConsequence, feeForTier, selectTier, toHoursBeforeMilli } from './tiers';

const TIERS = PLATFORM_DEFAULT_CANCELLATION_CONFIG.tiers;

/**
 * Spec 023 AC-2/AC-3 — the exact boundaries.
 *
 * These are the cases a cancellation system gets sued over, so each is asserted individually rather
 * than swept into a table-driven loop: a reader should be able to see "exactly 24 hours is free"
 * written down as a sentence.
 */
describe('cancellation tier selection (spec 023 AC-2/AC-3)', () => {
  it('exactly 24 hours before is the 0% tier', () => {
    expect(selectTier(TIERS, 24)?.feePercent).toBe(0);
  });

  it('more than 24 hours before is the 0% tier', () => {
    expect(selectTier(TIERS, 48)?.feePercent).toBe(0);
    expect(selectTier(TIERS, 24.001)?.feePercent).toBe(0);
  });

  it('a hair under 24 hours is the 25% tier', () => {
    expect(selectTier(TIERS, 23.999)?.feePercent).toBe(25);
  });

  it('exactly 12 hours before is the 25% tier', () => {
    expect(selectTier(TIERS, 12)?.feePercent).toBe(25);
  });

  it('a hair under 12 hours is the 50% tier', () => {
    expect(selectTier(TIERS, 11.999)?.feePercent).toBe(50);
  });

  it('under 12 hours is the 50% tier', () => {
    expect(selectTier(TIERS, 1)?.feePercent).toBe(50);
    expect(selectTier(TIERS, 0.001)?.feePercent).toBe(50);
  });

  /**
   * The one instant plain interval arithmetic would decide the other way — the seeded ladder's
   * `[0, 12)` rung would otherwise claim it. Spec 023 §3 is explicit that `hoursBefore <= 0` is a
   * single tier: at or after the scheduled time is never discounted.
   */
  it('exactly at the scheduled time is the 100% tier', () => {
    expect(selectTier(TIERS, 0)?.feePercent).toBe(100);
  });

  it('after the scheduled time is the 100% tier', () => {
    expect(selectTier(TIERS, -0.001)?.feePercent).toBe(100);
    expect(selectTier(TIERS, -72)?.feePercent).toBe(100);
  });

  it('the ladder is exhaustive: every timing selects some tier', () => {
    for (const hours of [-1000, -1, -0.0001, 0, 0.0001, 11.9, 12, 23.9, 24, 1000]) {
      expect(selectTier(TIERS, hours), `hoursBefore=${hours}`).not.toBeNull();
    }
  });

  it('an empty ladder selects nothing rather than guessing', () => {
    expect(selectTier([], 5)).toBeNull();
  });
});

describe('cancellation fee arithmetic (spec 023 AC-3)', () => {
  it('computes each tier exactly, in integer minor units', () => {
    expect(feeForTier(320_000, 0)).toBe(0);
    expect(feeForTier(320_000, 25)).toBe(80_000);
    expect(feeForTier(320_000, 50)).toBe(160_000);
    expect(feeForTier(320_000, 100)).toBe(320_000);
  });

  it('rounds half up on an amount that does not divide cleanly', () => {
    // 101 * 25 / 100 = 25.25 -> 25;  101 * 50 / 100 = 50.5 -> 51 (half UP, not half-even).
    expect(feeForTier(101, 25)).toBe(25);
    expect(feeForTier(101, 50)).toBe(51);
    expect(feeForTier(1, 50)).toBe(1);
    expect(feeForTier(3, 50)).toBe(2);
  });

  it('never exceeds the captured amount and is never negative', () => {
    for (const captured of [0, 1, 7, 999, 320_001]) {
      for (const percent of [0, 1, 25, 50, 99, 100]) {
        const fee = feeForTier(captured, percent);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(captured);
        expect(Number.isInteger(fee)).toBe(true);
      }
    }
  });

  it('refuses a non-integer or negative captured amount rather than coercing it', () => {
    expect(() => feeForTier(-1, 50)).toThrow();
    expect(() => feeForTier(10.5, 50)).toThrow();
  });

  it('refuses a percentage outside 0–100', () => {
    expect(() => feeForTier(100, 101)).toThrow();
    expect(() => feeForTier(100, -1)).toThrow();
    expect(() => feeForTier(100, 12.5)).toThrow();
  });

  it('fee + refund always equals the captured amount', () => {
    for (const hours of [48, 24, 18, 12, 6, 0, -5]) {
      for (const captured of [1, 999, 100_001, 320_000]) {
        const result = computeCancellationConsequence({ tiers: TIERS, hoursBefore: hours, capturedAmountMinorUnits: captured })!;
        expect(result.feeAmountMinorUnits + result.refundAmountMinorUnits).toBe(captured);
      }
    }
  });

  it('a free cancellation refunds everything and a 100% tier refunds nothing', () => {
    const free = computeCancellationConsequence({ tiers: TIERS, hoursBefore: 48, capturedAmountMinorUnits: 320_000 })!;
    expect(free.feeAmountMinorUnits).toBe(0);
    expect(free.refundAmountMinorUnits).toBe(320_000);

    const late = computeCancellationConsequence({ tiers: TIERS, hoursBefore: -1, capturedAmountMinorUnits: 320_000 })!;
    expect(late.feeAmountMinorUnits).toBe(320_000);
    expect(late.refundAmountMinorUnits).toBe(0);
  });
});

describe('audited timing (spec 003 AC-1: no float money or float columns)', () => {
  it('scales hours to an integer without losing sub-second fidelity', () => {
    expect(toHoursBeforeMilli(23.999)).toBe(23_999);
    expect(toHoursBeforeMilli(0)).toBe(0);
    expect(toHoursBeforeMilli(-1.5)).toBe(-1500);
    expect(Number.isInteger(toHoursBeforeMilli(12.3456))).toBe(true);
  });

  it('clamps a pathological scheduled time into the integer column rather than overflowing it', () => {
    expect(toHoursBeforeMilli(1e12)).toBeLessThanOrEqual(2_000_000_000);
    expect(toHoursBeforeMilli(-1e12)).toBeGreaterThanOrEqual(-2_000_000_000);
  });
});
