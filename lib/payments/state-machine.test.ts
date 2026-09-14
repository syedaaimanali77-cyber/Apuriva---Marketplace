import { describe, expect, it } from 'vitest';
import { PAYMENT_STATUSES, SPEC_021_PAYMENT_TRANSITIONS, isAllowedPaymentTransition, isTerminalPaymentStatus } from './state-machine';

/** Spec 021 §4 "Payment status machine". */
describe('payment state machine (spec 021 §4)', () => {
  /** The WHOLE vocabulary is authored here once, including statuses spec 022 will transition into. */
  it('authors the whole payment status vocabulary in one place', () => {
    expect([...PAYMENT_STATUSES]).toEqual([
      'created',
      'requires_action',
      'authorized',
      'captured',
      'failed',
      'refunded',
      'partially_refunded',
    ]);
  });

  it('allows exactly the nine transitions this spec performs', () => {
    expect(SPEC_021_PAYMENT_TRANSITIONS).toHaveLength(9);
    for (const [from, to] of SPEC_021_PAYMENT_TRANSITIONS) expect(isAllowedPaymentTransition(from, to)).toBe(true);
  });

  /** Every pair not seeded by 0017 is refused — the friendly half of the spec 003 trigger. */
  it('refuses every pair outside the seeded graph', () => {
    const allowed = new Set(SPEC_021_PAYMENT_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (allowed.has(`${from}->${to}`)) continue;
        expect(isAllowedPaymentTransition(from, to)).toBe(false);
      }
    }
  });

  /**
   * §4 — refunds are spec 022's. This spec names the statuses (one author for the vocabulary) but
   * seeds and performs neither transition into them.
   */
  it('owns no transition into refunded or partially_refunded — spec 022 seeds both', () => {
    expect(isAllowedPaymentTransition('captured', 'refunded')).toBe(false);
    expect(isAllowedPaymentTransition('captured', 'partially_refunded')).toBe(false);
    expect(SPEC_021_PAYMENT_TRANSITIONS.some(([, to]) => to === 'refunded' || to === 'partially_refunded')).toBe(false);
  });

  it('treats captured and failed as terminal here', () => {
    expect(isTerminalPaymentStatus('captured')).toBe(true);
    expect(isTerminalPaymentStatus('failed')).toBe(true);
    expect(isTerminalPaymentStatus('created')).toBe(false);
    expect(isTerminalPaymentStatus('requires_action')).toBe(false);
    expect(isTerminalPaymentStatus('authorized')).toBe(false);
    expect(SPEC_021_PAYMENT_TRANSITIONS.some(([from]) => from === 'captured' || from === 'failed')).toBe(false);
  });
});
