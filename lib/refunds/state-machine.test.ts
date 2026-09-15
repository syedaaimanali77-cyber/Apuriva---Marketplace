import { describe, expect, it } from 'vitest';
import {
  IN_FLIGHT_REFUND_STATUSES,
  REFUND_STATUSES,
  SPEC_022_REFUND_TRANSITIONS,
  TERMINAL_REFUND_STATUSES,
  isAllowedRefundTransition,
  isInFlightRefundStatus,
  isTerminalRefundStatus,
} from './state-machine';

/** Spec 022 §4 "Refund status machine". */
describe('refund state machine (spec 022 §4)', () => {
  it('authors the whole refund status vocabulary in one place', () => {
    expect([...REFUND_STATUSES]).toEqual(['requested', 'processing', 'completed', 'failed']);
  });

  it('allows exactly the three transitions this spec performs', () => {
    expect(SPEC_022_REFUND_TRANSITIONS).toHaveLength(3);
    for (const [from, to] of SPEC_022_REFUND_TRANSITIONS) expect(isAllowedRefundTransition(from, to)).toBe(true);
  });

  /** Every pair not seeded by 0018 is refused — the friendly half of the spec 003 trigger. */
  it('refuses every pair outside the seeded graph', () => {
    const allowed = new Set(SPEC_022_REFUND_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    for (const from of REFUND_STATUSES) {
      for (const to of REFUND_STATUSES) {
        if (allowed.has(`${from}->${to}`)) continue;
        expect(isAllowedRefundTransition(from, to)).toBe(false);
      }
    }
  });

  /**
   * AC-6 — a retry after failure is a NEW refund row, never a resurrection, so that every provider
   * attempt keeps its own immutable record and its own reference.
   */
  it('has no path out of failed — a retry is a new refund row', () => {
    expect(isAllowedRefundTransition('failed', 'processing')).toBe(false);
    expect(isAllowedRefundTransition('failed', 'requested')).toBe(false);
    expect(isAllowedRefundTransition('failed', 'completed')).toBe(false);
    expect(SPEC_022_REFUND_TRANSITIONS.some(([from]) => from === 'failed')).toBe(false);
  });

  /** A completed refund is terminal: the money is back and the record never moves again. */
  it('has no path out of completed', () => {
    expect(SPEC_022_REFUND_TRANSITIONS.some(([from]) => from === 'completed')).toBe(false);
  });

  /** Nothing can fail before the provider has been asked. */
  it('cannot fail straight from requested', () => {
    expect(isAllowedRefundTransition('requested', 'failed')).toBe(false);
    expect(isAllowedRefundTransition('requested', 'completed')).toBe(false);
  });

  /**
   * I-1/I-7 — which statuses hold a reservation. `processing` MUST be in-flight: that is what keeps
   * an ambiguous refund's money reserved instead of freeing it for a second refund (AC-7).
   */
  it('treats requested and processing as in-flight, and completed/failed as terminal', () => {
    expect([...IN_FLIGHT_REFUND_STATUSES]).toEqual(['requested', 'processing']);
    expect([...TERMINAL_REFUND_STATUSES]).toEqual(['completed', 'failed']);
    expect(isInFlightRefundStatus('processing')).toBe(true);
    expect(isInFlightRefundStatus('requested')).toBe(true);
    expect(isInFlightRefundStatus('completed')).toBe(false);
    expect(isTerminalRefundStatus('failed')).toBe(true);
    expect(isTerminalRefundStatus('processing')).toBe(false);
  });
});
