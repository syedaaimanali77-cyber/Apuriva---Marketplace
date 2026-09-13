import { describe, expect, it } from 'vitest';
import { acceptAllowedForPricingModel, actionForPricingModel, availableActionFor, isActionableStatus } from './actions';

describe('lib/matching/actions (spec 017 AC-5)', () => {
  describe('actionForPricingModel — all five PRICING_MODELS mapped', () => {
    const table: [string, string][] = [
      ['fixed', 'accept'],
      ['package', 'accept'],
      ['hourly', 'accept'],
      ['quote', 'send_offer'],
      ['custom', 'send_offer'],
    ];
    for (const [model, expected] of table) {
      it(`${model} -> ${expected}`, () => {
        expect(actionForPricingModel(model)).toBe(expected);
      });
    }

    it('an unknown pricing model never implies a binding accept', () => {
      expect(actionForPricingModel('unknown-model')).toBe('decline_only');
    });
  });

  describe('acceptAllowedForPricingModel', () => {
    it('true only for fixed/package/hourly', () => {
      expect(acceptAllowedForPricingModel('fixed')).toBe(true);
      expect(acceptAllowedForPricingModel('package')).toBe(true);
      expect(acceptAllowedForPricingModel('hourly')).toBe(true);
      expect(acceptAllowedForPricingModel('quote')).toBe(false);
      expect(acceptAllowedForPricingModel('custom')).toBe(false);
    });
  });

  describe('isActionableStatus', () => {
    it('matching and offers_open are actionable; everything else is not', () => {
      expect(isActionableStatus('matching')).toBe(true);
      expect(isActionableStatus('offers_open')).toBe(true);
      for (const status of ['draft', 'submitted', 'provider_selected', 'booking_created', 'cancelled', 'expired', 'completed']) {
        expect(isActionableStatus(status)).toBe(false);
      }
    });
  });

  describe('availableActionFor', () => {
    it('a fixed-price service in matching with no prior response offers accept', () => {
      expect(availableActionFor('fixed', 'matching', 'none')).toBe('accept');
    });

    it('a quote-based service in matching with no prior response offers send_offer', () => {
      expect(availableActionFor('quote', 'offers_open', 'none')).toBe('send_offer');
    });

    it('a provider who already responded gets decline_only regardless of pricing model', () => {
      expect(availableActionFor('fixed', 'matching', 'accepted')).toBe('decline_only');
      expect(availableActionFor('fixed', 'matching', 'declined')).toBe('decline_only');
      expect(availableActionFor('quote', 'matching', 'offer_sent')).toBe('decline_only');
    });

    it('a request no longer in an actionable status gets decline_only even with no prior response', () => {
      expect(availableActionFor('fixed', 'cancelled', 'none')).toBe('decline_only');
      expect(availableActionFor('fixed', 'provider_selected', 'none')).toBe('decline_only');
    });
  });
});
