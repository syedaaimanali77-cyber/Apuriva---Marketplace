/**
 * Spec 031 §6 unit — the eligibility predicate (AC-1, DECIDED-1). PURE: no database, no I/O.
 *
 * The rule under test is the one the Prompt-1 review resolved: a dispute is eligible exactly while
 * the booking is `protected` AND its payment protection is `held` — i.e. inside spec 021's
 * payment-protection window, the repository's one existing deadline between "the money can still be
 * stopped" and "the money is gone". Every other booking state is refused, and the test enumerates
 * them rather than spot-checking, so a later spec adding a status cannot quietly become eligible.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDisputeEligibility, type EligibilityFacts } from './create';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentProtectionState } from '@/lib/types/payments';

const ALL_BOOKING_STATUSES: BookingStatus[] = [
  'pending',
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
  'completed',
  'protected',
  'settled',
  'cancelled',
  'disputed',
  'refunded',
  'failed',
];

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return { bookingStatus: 'protected', protectionState: 'held', hasLiveDispute: false, ...overrides };
}

describe('dispute eligibility (spec 031)', () => {
  it('AC-1: protected + held is eligible', () => {
    expect(evaluateDisputeEligibility(facts())).toEqual({ eligible: true });
  });

  it('AC-1: every booking status other than protected is refused', () => {
    for (const status of ALL_BOOKING_STATUSES) {
      const result = evaluateDisputeEligibility(facts({ bookingStatus: status }));
      if (status === 'protected') {
        expect(result.eligible).toBe(true);
      } else {
        expect(result).toEqual({ eligible: false, reason: 'booking_not_protected' });
      }
    }
  });

  it('refuses `completed`, even though it precedes protected — there is no protection state to hold yet', () => {
    expect(evaluateDisputeEligibility(facts({ bookingStatus: 'completed', protectionState: null }))).toEqual({
      eligible: false,
      reason: 'booking_not_protected',
    });
  });

  it('refuses `settled`, because the money has already been released', () => {
    expect(evaluateDisputeEligibility(facts({ bookingStatus: 'settled', protectionState: 'released' }))).toEqual({
      eligible: false,
      reason: 'booking_not_protected',
    });
  });

  it('AC-1: a protected booking whose protection is not held is refused', () => {
    const states: (PaymentProtectionState | null)[] = ['released', 'disputed', null];
    for (const protectionState of states) {
      expect(evaluateDisputeEligibility(facts({ protectionState }))).toEqual({
        eligible: false,
        reason: 'protection_not_held',
      });
    }
  });

  it('refuses a booking with no payment at all rather than treating it as eligible', () => {
    expect(evaluateDisputeEligibility(facts({ protectionState: null }))).toEqual({
      eligible: false,
      reason: 'protection_not_held',
    });
  });

  it('AC-1: an existing live dispute is refused, and is checked BEFORE the other two rules', () => {
    // Ordering matters for the error the caller receives: a second attempt on an already-disputed
    // booking must be told `dispute_already_open` (409), not `booking_not_protected` (422) — by
    // then the booking is `disputed`, so the state check would otherwise mask the real reason.
    expect(evaluateDisputeEligibility(facts({ hasLiveDispute: true, bookingStatus: 'disputed' }))).toEqual({
      eligible: false,
      reason: 'dispute_already_open',
    });
  });

  it('is a pure function of its facts — the same input always gives the same answer', () => {
    const input = facts();
    expect(evaluateDisputeEligibility(input)).toEqual(evaluateDisputeEligibility(input));
  });
});
