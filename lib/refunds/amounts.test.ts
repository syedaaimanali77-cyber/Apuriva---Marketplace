import { describe, expect, it } from 'vitest';
import {
  fitsWithinRemaining,
  isFullyRefunded,
  isValidCurrencyCode,
  isValidRefundAmount,
  linesShareCurrency,
  linesSumTo,
  type RefundablePosition,
} from './amounts';

function position(over: Partial<RefundablePosition> = {}): RefundablePosition {
  const captured = over.capturedAmountMinorUnits ?? 100_000;
  const completed = over.completedRefundedMinorUnits ?? 0;
  const inFlight = over.inFlightRefundedMinorUnits ?? 0;
  return {
    capturedAmountMinorUnits: captured,
    completedRefundedMinorUnits: completed,
    inFlightRefundedMinorUnits: inFlight,
    remainingRefundableMinorUnits: over.remainingRefundableMinorUnits ?? Math.max(0, captured - completed - inFlight),
    currencyCode: over.currencyCode ?? 'PKR',
  };
}

/** Spec 022 §3 "Financial invariants" — AC-2, AC-5, AC-8's arithmetic, provable without a database. */
describe('refund amounts (spec 022 AC-2/AC-5)', () => {
  /** I-3/I-4 — no zero, no negative, no fractional minor unit. */
  it('accepts only positive whole minor units', () => {
    expect(isValidRefundAmount(1)).toBe(true);
    expect(isValidRefundAmount(100_000)).toBe(true);
    expect(isValidRefundAmount(0)).toBe(false);
    expect(isValidRefundAmount(-1)).toBe(false);
    expect(isValidRefundAmount(10.5)).toBe(false);
    expect(isValidRefundAmount('100' as unknown)).toBe(false);
    expect(isValidRefundAmount(null as unknown)).toBe(false);
    expect(isValidRefundAmount(Number.NaN)).toBe(false);
  });

  it('accepts only three-letter ISO-4217 currency codes', () => {
    expect(isValidCurrencyCode('PKR')).toBe(true);
    expect(isValidCurrencyCode('pkr')).toBe(false);
    expect(isValidCurrencyCode('PK')).toBe(false);
    expect(isValidCurrencyCode('PKRR')).toBe(false);
    expect(isValidCurrencyCode(null as unknown)).toBe(false);
  });

  /** I-5 — the stored total can never drift from the lines that explain it. */
  it('requires lines to sum exactly to the refund total', () => {
    const lines = [
      { lineAmountMinorUnits: 30_000, lineCurrencyCode: 'PKR', reason: 'a' },
      { lineAmountMinorUnits: 20_000, lineCurrencyCode: 'PKR', reason: 'b' },
    ];
    expect(linesSumTo(lines, 50_000)).toBe(true);
    expect(linesSumTo(lines, 49_999)).toBe(false);
    expect(linesSumTo(lines, 50_001)).toBe(false);
    // A refund with no lines has no explanation, and is refused rather than treated as zero.
    expect(linesSumTo([], 0)).toBe(false);
  });

  /** I-6 — no cross-currency refund is representable. */
  it('requires every line to share the refund currency', () => {
    expect(linesShareCurrency([{ lineAmountMinorUnits: 1, lineCurrencyCode: 'PKR', reason: 'a' }], 'PKR')).toBe(true);
    expect(linesShareCurrency([{ lineAmountMinorUnits: 1, lineCurrencyCode: 'USD', reason: 'a' }], 'PKR')).toBe(false);
  });

  /**
   * AC-5 — THE boundary. Refunding exactly what remains is allowed; one minor unit more is not.
   * This is the assertion that would catch an off-by-one in the cap.
   */
  it('permits exactly the remaining amount and refuses one minor unit more', () => {
    const p = position({ capturedAmountMinorUnits: 100_000 });
    expect(fitsWithinRemaining(100_000, p)).toBe(true);
    expect(fitsWithinRemaining(100_001, p)).toBe(false);
  });

  /**
   * I-1 — the cap is against BOTH the captured amount and everything already completed or in
   * flight. A previously completed refund shrinks what remains.
   */
  it('counts completed refunds against the remaining amount', () => {
    const p = position({ capturedAmountMinorUnits: 100_000, completedRefundedMinorUnits: 60_000 });
    expect(p.remainingRefundableMinorUnits).toBe(40_000);
    expect(fitsWithinRemaining(40_000, p)).toBe(true);
    expect(fitsWithinRemaining(40_001, p)).toBe(false);
  });

  /**
   * I-1 — and so does an IN-FLIGHT one. This is the half that stops AC-8's concurrent over-refund:
   * a reservation that has not completed yet still consumes budget.
   */
  it('counts in-flight refunds against the remaining amount', () => {
    const p = position({ capturedAmountMinorUnits: 100_000, inFlightRefundedMinorUnits: 70_000 });
    expect(p.remainingRefundableMinorUnits).toBe(30_000);
    expect(fitsWithinRemaining(30_000, p)).toBe(true);
    expect(fitsWithinRemaining(30_001, p)).toBe(false);
  });

  it('counts completed and in-flight refunds together', () => {
    const p = position({
      capturedAmountMinorUnits: 100_000,
      completedRefundedMinorUnits: 40_000,
      inFlightRefundedMinorUnits: 35_000,
    });
    expect(p.remainingRefundableMinorUnits).toBe(25_000);
    expect(fitsWithinRemaining(25_000, p)).toBe(true);
    expect(fitsWithinRemaining(25_001, p)).toBe(false);
  });

  /** AC-5 — "fully refunded" is decided by COMPLETED refunds alone; in-flight money is not back yet. */
  it('reports fully refunded only once completed refunds reach the captured amount', () => {
    expect(isFullyRefunded(position({ completedRefundedMinorUnits: 100_000 }))).toBe(true);
    expect(isFullyRefunded(position({ completedRefundedMinorUnits: 99_999 }))).toBe(false);
    // In-flight is NOT back yet, however large.
    expect(isFullyRefunded(position({ completedRefundedMinorUnits: 0, inFlightRefundedMinorUnits: 100_000 }))).toBe(false);
  });

  /** Nothing captured means nothing refundable, rather than an unbounded budget. */
  it('treats an uncaptured payment as having nothing refundable', () => {
    const p = position({ capturedAmountMinorUnits: 0 });
    expect(p.remainingRefundableMinorUnits).toBe(0);
    expect(fitsWithinRemaining(1, p)).toBe(false);
    expect(isFullyRefunded(p)).toBe(false);
  });
});
