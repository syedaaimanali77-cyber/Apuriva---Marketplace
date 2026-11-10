import { describe, expect, it } from 'vitest';
import { PRICING_MODELS, initialChargeAmountMinorUnits, resolvePaymentTiming } from './timing';

/** Spec 021 §3 "Payment timing" — AC-1, AC-2, AC-3. */
describe('payment timing (spec 021 AC-1/AC-2/AC-3)', () => {
  /**
   * AC-1/AC-2 — every pricing model this repository has resolves to the same timing, because every
   * booking is created from an accepted offer. For a fixed/scheduled service and an offer-based one
   * that is literally the same instant, which is a fact about the repository, not an ambiguity.
   */
  it('resolves every current pricing model to at_booking_confirmation', () => {
    for (const pricingModel of PRICING_MODELS) {
      expect(resolvePaymentTiming({ pricingModel })).toEqual({ kind: 'at_booking_confirmation' });
    }
  });

  /** AC-3 — the deposit branch is typed and reachable only when real deposit data is supplied. */
  it('resolves deposit timing with its deposit amount when deposit data exists', () => {
    expect(resolvePaymentTiming({ pricingModel: 'fixed', depositAmountMinorUnits: 50_000 })).toEqual({
      kind: 'deposit_then_remainder',
      depositAmountMinorUnits: 50_000,
    });
  });

  /**
   * AC-3 — and it is UNREACHABLE for every service in this repository, because no deposit column
   * exists. Master spec §133.5 forbids inventing one, so the resolver must not default a deposit
   * into existence from an absent, null or zero value.
   */
  it('is unreachable without real deposit data — no deposit is defaulted into existence', () => {
    for (const pricingModel of PRICING_MODELS) {
      expect(resolvePaymentTiming({ pricingModel }).kind).toBe('at_booking_confirmation');
      expect(resolvePaymentTiming({ pricingModel, depositAmountMinorUnits: null }).kind).toBe('at_booking_confirmation');
      expect(resolvePaymentTiming({ pricingModel, depositAmountMinorUnits: 0 }).kind).toBe('at_booking_confirmation');
    }
  });

  it('charges the whole agreed price at booking confirmation, and only the deposit otherwise', () => {
    expect(initialChargeAmountMinorUnits({ kind: 'at_booking_confirmation' }, 320_000)).toBe(320_000);
    expect(
      initialChargeAmountMinorUnits({ kind: 'deposit_then_remainder', depositAmountMinorUnits: 50_000 }, 320_000),
    ).toBe(50_000);
  });
});
