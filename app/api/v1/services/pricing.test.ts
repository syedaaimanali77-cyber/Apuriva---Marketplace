import { describe, expect, it } from 'vitest';
import { computePriceDisplay } from '@/lib/service-page/pricing';

describe('computePriceDisplay (spec 011 AC-2, unit)', () => {
  it('fixed -> exact, using the cheapest package amount', () => {
    const result = computePriceDisplay('fixed', [{ amountMinorUnits: 5000, currencyCode: 'USD' }]);
    expect(result).toEqual({ type: 'exact', amountMinorUnits: 5000, currencyCode: 'USD' });
  });

  it('package -> starting, using the cheapest of multiple packages', () => {
    const result = computePriceDisplay('package', [
      { amountMinorUnits: 9000, currencyCode: 'USD' },
      { amountMinorUnits: 4000, currencyCode: 'USD' },
    ]);
    expect(result).toEqual({ type: 'starting', amountMinorUnits: 4000, currencyCode: 'USD' });
  });

  it('custom -> range', () => {
    const result = computePriceDisplay('custom', [{ amountMinorUnits: 3000, currencyCode: 'USD' }]);
    expect(result.type).toBe('range');
  });

  it('quote -> quote, never an amount even when packages exist', () => {
    const result = computePriceDisplay('quote', [{ amountMinorUnits: 3000, currencyCode: 'USD' }]);
    expect(result).toEqual({ type: 'quote' });
  });

  it('hourly -> hourly rate', () => {
    const result = computePriceDisplay('hourly', [{ amountMinorUnits: 2500, currencyCode: 'USD' }]);
    expect(result).toEqual({ type: 'hourly', amountMinorUnits: 2500, currencyCode: 'USD' });
  });

  it('a pricing model needing an amount, with no packages yet, has no fabricated amount', () => {
    const result = computePriceDisplay('fixed', []);
    expect(result).toEqual({ type: 'exact' });
  });
});
