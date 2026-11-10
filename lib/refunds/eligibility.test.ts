import { afterEach, describe, expect, it } from 'vitest';
import {
  getRefundEligibilityGate,
  invalidEligibilityField,
  registerRefundEligibilityGate,
  resetRefundEligibilityGate,
  type RefundEligibility,
} from './eligibility';

const VALID: RefundEligibility = {
  eligible: true,
  amountMinorUnits: 50_000,
  currencyCode: 'PKR',
  reason: 'Cancelled within the free window',
};

/** Spec 022 §3 "Eligibility seam" (AC-1) — spec 023 owns the policy; this owns the contract. */
describe('refund eligibility gate (spec 022 AC-1)', () => {
  afterEach(() => resetRefundEligibilityGate());

  /**
   * The shipped default declines. That is CORRECT rather than a stub: with no policy defined,
   * nothing is automatically refundable. A default-allow here would refund money on a rule nobody
   * has written.
   */
  it('declines by default, because no policy exists yet', async () => {
    const decision = await getRefundEligibilityGate()(null as never, 'booking-1');
    expect(decision.eligible).toBe(false);
  });

  it('uses the gate spec 023 registers', async () => {
    registerRefundEligibilityGate(async () => VALID);
    const decision = await getRefundEligibilityGate()(null as never, 'booking-1');
    expect(decision).toEqual(VALID);
  });

  it('accepts a complete decision', () => {
    expect(invalidEligibilityField(VALID, 'PKR')).toBeNull();
  });

  /** An ineligible decision has nothing to validate — it is not a malformed eligible one. */
  it('does not validate the shape of an ineligible decision', () => {
    expect(invalidEligibilityField({ eligible: false }, 'PKR')).toBeNull();
  });

  /**
   * AC-1's "absent, invalid or contradictory" cases. A half-specified decision is a defect in the
   * supplying spec, never a reason to guess an amount — each is named so the route can report which.
   */
  it('rejects a missing or malformed amount rather than defaulting one', () => {
    expect(invalidEligibilityField({ ...VALID, amountMinorUnits: undefined }, 'PKR')).toBe('amountMinorUnits');
    expect(invalidEligibilityField({ ...VALID, amountMinorUnits: 0 }, 'PKR')).toBe('amountMinorUnits');
    expect(invalidEligibilityField({ ...VALID, amountMinorUnits: -5 }, 'PKR')).toBe('amountMinorUnits');
    expect(invalidEligibilityField({ ...VALID, amountMinorUnits: 10.5 }, 'PKR')).toBe('amountMinorUnits');
  });

  it('rejects a missing, malformed or contradictory currency rather than coercing it', () => {
    expect(invalidEligibilityField({ ...VALID, currencyCode: undefined }, 'PKR')).toBe('currencyCode');
    expect(invalidEligibilityField({ ...VALID, currencyCode: 'pkr' }, 'PKR')).toBe('currencyCode');
    // Contradictory: a well-formed currency that is not the booking's.
    expect(invalidEligibilityField({ ...VALID, currencyCode: 'USD' }, 'PKR')).toBe('currencyCode');
  });

  it('rejects a missing or blank reason — every refund line must be explainable', () => {
    expect(invalidEligibilityField({ ...VALID, reason: undefined }, 'PKR')).toBe('reason');
    expect(invalidEligibilityField({ ...VALID, reason: '   ' }, 'PKR')).toBe('reason');
  });

  it('restores the inert default on reset, so no suite leaks a policy into another', async () => {
    registerRefundEligibilityGate(async () => VALID);
    resetRefundEligibilityGate();
    expect((await getRefundEligibilityGate()(null as never, 'b')).eligible).toBe(false);
  });
});
