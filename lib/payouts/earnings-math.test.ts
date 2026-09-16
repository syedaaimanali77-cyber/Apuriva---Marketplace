import { afterEach, describe, expect, it } from 'vitest';
import { computeLineFigures, feeOn, PlatformFeeUnconfigured, resolvePlatformFeeBps } from './fees';

const original = process.env.PLATFORM_FEE_BPS;

/** Spec 024 §3.3 — the integer-only earnings arithmetic (AC-3, AC-14). */
describe('earnings math (spec 024 §3.3)', () => {
  afterEach(() => {
    if (original === undefined) delete process.env.PLATFORM_FEE_BPS;
    else process.env.PLATFORM_FEE_BPS = original;
  });

  it('rounds the fee half-up at every boundary', () => {
    expect(feeOn(0, 1000)).toBe(0);
    expect(feeOn(5, 1000)).toBe(1); // 0.5 → 1
    expect(feeOn(4, 1000)).toBe(0); // 0.4 → 0
    expect(feeOn(15, 1000)).toBe(2); // 1.5 → 2
    expect(feeOn(14, 1000)).toBe(1); // 1.4 → 1
    expect(feeOn(1, 5000)).toBe(1); // 0.5 → 1
    expect(feeOn(123_456, 0)).toBe(0);
    expect(feeOn(123_456, 10_000)).toBe(123_456);
  });

  it('net equals gross minus fee plus adjustments minus refunds, per line', () => {
    for (const [gross, bps, refunded] of [
      [320_000, 1000, 0],
      [320_000, 1000, 50_000],
      [320_000, 1500, 320_000],
      [99_999, 333, 12_345],
      [1, 10_000, 0],
    ] as const) {
      const f = computeLineFigures(gross, bps, refunded);
      expect(f.netAmountMinorUnits).toBe(gross - refunded - f.feeAmountMinorUnits + f.feeReversalAmountMinorUnits);
      expect(f.netAmountMinorUnits).toBeGreaterThanOrEqual(0);
      expect(f.feeReversalAmountMinorUnits).toBeGreaterThanOrEqual(0);
      expect(f.feeReversalAmountMinorUnits).toBeLessThanOrEqual(f.feeAmountMinorUnits);
    }
  });

  it('charges no fee on refunded money: a full refund leaves net and net fee at zero', () => {
    const f = computeLineFigures(320_000, 1000, 320_000);
    expect(f.netAmountMinorUnits).toBe(0);
    expect(f.feeAmountMinorUnits - f.feeReversalAmountMinorUnits).toBe(0);
  });

  it('repeated partial refunds do not drift: N partials equal one refund of the same total', () => {
    const gross = 100_003;
    const bps = 1337;
    const partials = [7, 13, 1_001, 25_555, 3];
    let cumulative = 0;
    let lastNet = computeLineFigures(gross, bps, 0).netAmountMinorUnits;
    let sumOfDeltas = 0;
    for (const partial of partials) {
      cumulative += partial;
      const next = computeLineFigures(gross, bps, cumulative).netAmountMinorUnits;
      sumOfDeltas += lastNet - next;
      lastNet = next;
    }
    const oneShot = computeLineFigures(gross, bps, cumulative);
    expect(lastNet).toBe(oneShot.netAmountMinorUnits);
    expect(sumOfDeltas).toBe(computeLineFigures(gross, bps, 0).netAmountMinorUnits - oneShot.netAmountMinorUnits);
  });

  it('a later fee-rate change does not alter an existing line', () => {
    const atCreation = computeLineFigures(320_000, 1000, 0);
    // The rate is snapshotted per line: recomputing with the SAME stored bps gives the same figures,
    // whatever PLATFORM_FEE_BPS says now.
    process.env.PLATFORM_FEE_BPS = '2500';
    expect(computeLineFigures(320_000, 1000, 0)).toEqual(atCreation);
  });

  it('rejects non-integer, negative and impossible inputs', () => {
    expect(() => feeOn(1.5, 1000)).toThrow(RangeError);
    expect(() => feeOn(-1, 1000)).toThrow(RangeError);
    expect(() => feeOn(1, 10_001)).toThrow(RangeError);
    expect(() => feeOn(1, 0.5)).toThrow(RangeError);
    expect(() => computeLineFigures(0, 1000, 0)).toThrow(RangeError);
    expect(() => computeLineFigures(100, 1000, 101)).toThrow(RangeError);
    expect(() => computeLineFigures(100, 1000, -1)).toThrow(RangeError);
  });

  it('resolvePlatformFeeBps refuses unset and out-of-range values rather than guessing', () => {
    delete process.env.PLATFORM_FEE_BPS;
    expect(() => resolvePlatformFeeBps()).toThrow(PlatformFeeUnconfigured);
    for (const bad of ['', 'abc', '-1', '10001', '1.5', ' 12x']) {
      process.env.PLATFORM_FEE_BPS = bad;
      expect(() => resolvePlatformFeeBps()).toThrow(PlatformFeeUnconfigured);
    }
    process.env.PLATFORM_FEE_BPS = '0';
    expect(resolvePlatformFeeBps()).toBe(0);
    process.env.PLATFORM_FEE_BPS = '10000';
    expect(resolvePlatformFeeBps()).toBe(10_000);
  });
});
