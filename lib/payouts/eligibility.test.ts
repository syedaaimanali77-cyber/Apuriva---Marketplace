import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTION_WINDOW_HOURS,
  hasProtectionWindowElapsed,
  nextProtectionState,
  protectionWindowEndsAt,
} from '@/lib/payments/protection-window';
import { evaluateEligibility, type EligibilityFacts } from './eligibility';

const ELIGIBLE: EligibilityFacts = {
  protectionState: 'released',
  bookingStatus: 'settled',
  paymentStatus: 'captured',
  inFlightRefunds: 0,
  unreconciledRefunds: 0,
};

/**
 * Spec 024 §3.4 (AC-1). No protection duration exists in spec 024: the boundary tests compose spec
 * 021's own window arithmetic with this spec's evaluator, so the eligibility boundary is exactly
 * spec 021's release boundary.
 */
describe('payout eligibility (spec 024 §3.4)', () => {
  it('released and settled advances the line', () => {
    expect(evaluateEligibility(ELIGIBLE)).toEqual({ eligible: true });
    expect(evaluateEligibility({ ...ELIGIBLE, paymentStatus: 'partially_refunded' })).toEqual({ eligible: true });
  });

  it('held, disputed, unsettled, in-flight refund and unreconciled refund each block', () => {
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: 'held' })).toEqual({ eligible: false, reason: 'protection_not_released' });
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: 'disputed' })).toEqual({ eligible: false, reason: 'protection_not_released' });
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: null })).toEqual({ eligible: false, reason: 'protection_not_released' });
    expect(evaluateEligibility({ ...ELIGIBLE, bookingStatus: 'protected' })).toEqual({ eligible: false, reason: 'booking_not_settled' });
    expect(evaluateEligibility({ ...ELIGIBLE, bookingStatus: 'refunded' })).toEqual({ eligible: false, reason: 'booking_not_settled' });
    expect(evaluateEligibility({ ...ELIGIBLE, paymentStatus: 'refunded' })).toEqual({ eligible: false, reason: 'payment_not_payable' });
    expect(evaluateEligibility({ ...ELIGIBLE, inFlightRefunds: 1 })).toEqual({ eligible: false, reason: 'refund_in_flight' });
    expect(evaluateEligibility({ ...ELIGIBLE, unreconciledRefunds: 1 })).toEqual({ eligible: false, reason: 'refund_unreconciled' });
  });

  it('settled without released blocks, and released without settled blocks', () => {
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: 'held', bookingStatus: 'settled' }).eligible).toBe(false);
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: 'released', bookingStatus: 'completed' }).eligible).toBe(false);
  });

  for (const hours of [DEFAULT_PROTECTION_WINDOW_HOURS, 1, 720]) {
    it(`is not eligible one millisecond before the ${hours}h window closes, and is at the closing instant`, () => {
      const start = new Date('2026-09-01T10:00:00.000Z');
      const closes = protectionWindowEndsAt(start, hours)!;
      const justBefore = new Date(closes.getTime() - 1);

      const stateBefore = nextProtectionState({ current: 'held', disputeOpen: false, windowElapsed: hasProtectionWindowElapsed(start, hours, justBefore) });
      const stateAt = nextProtectionState({ current: 'held', disputeOpen: false, windowElapsed: hasProtectionWindowElapsed(start, hours, closes) });

      expect(evaluateEligibility({ ...ELIGIBLE, protectionState: stateBefore, bookingStatus: stateBefore === 'released' ? 'settled' : 'protected' }).eligible).toBe(false);
      expect(evaluateEligibility({ ...ELIGIBLE, protectionState: stateAt, bookingStatus: stateAt === 'released' ? 'settled' : 'protected' }).eligible).toBe(true);
    });
  }

  it('an open dispute holds eligibility however much of the window has passed', () => {
    const state = nextProtectionState({ current: 'held', disputeOpen: true, windowElapsed: true });
    expect(evaluateEligibility({ ...ELIGIBLE, protectionState: state }).eligible).toBe(false);
  });
});
