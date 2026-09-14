import { describe, expect, it } from 'vitest';
import { availabilityFitFrom, whyThisProvider } from './why-this-provider';

/** Spec 019 AC-11 — fixed reason codes from the STORED spec 017 breakdown. No AI, no numbers, no prose. */
const factor = (normalized: number, available = true) => ({ normalized, weight: 20, available });

const FULL_BREAKDOWN = {
  serviceMatch: factor(1),
  availability: factor(1),
  location: factor(0.9),
  rating: factor(0, false),
  reliability: factor(0, false),
  priceFit: factor(0, false),
  experience: factor(0, false),
  verification: factor(0, false),
  historicalPerformance: factor(0, false),
};

describe('why this provider (spec 019 AC-11)', () => {
  it('emits top_match, available_at_requested_time and nearby in fixed order', () => {
    expect(whyThisProvider(FULL_BREAKDOWN, true)).toEqual(['top_match', 'available_at_requested_time', 'nearby']);
    // Order is positional, never input-dependent.
    expect(whyThisProvider({ location: factor(0.95), availability: factor(1) }, true)).toEqual([
      'top_match',
      'available_at_requested_time',
      'nearby',
    ]);
  });

  it('omits top_match when the offer is not the Top Match', () => {
    expect(whyThisProvider(FULL_BREAKDOWN, false)).toEqual(['available_at_requested_time', 'nearby']);
  });

  it('nearby only at normalized >= 0.8', () => {
    expect(whyThisProvider({ location: factor(0.8) }, false)).toEqual(['nearby']);
    expect(whyThisProvider({ location: factor(0.79) }, false)).toEqual([]);
  });

  it('available_at_requested_time only at an exact availability fit', () => {
    expect(whyThisProvider({ availability: factor(1) }, false)).toEqual(['available_at_requested_time']);
    expect(whyThisProvider({ availability: factor(0.5) }, false)).toEqual([]);
  });

  it('unavailable factors, null breakdown and constant factors emit nothing', () => {
    expect(whyThisProvider({ availability: factor(1, false), location: factor(1, false) }, false)).toEqual([]);
    expect(whyThisProvider(null, false)).toEqual([]);
    expect(whyThisProvider(undefined, false)).toEqual([]);
    expect(whyThisProvider('not-an-object', false)).toEqual([]);
    expect(whyThisProvider({ availability: { normalized: 'x', available: true } }, false)).toEqual([]);
    // serviceMatch/verification are constant across eligible providers — never a reason (spec 017 risk 8).
    expect(whyThisProvider({ serviceMatch: factor(1), verification: factor(1) }, false)).toEqual([]);
  });

  it('same inputs always produce the same output', () => {
    expect(whyThisProvider(FULL_BREAKDOWN, true)).toEqual(whyThisProvider(FULL_BREAKDOWN, true));
  });

  it('availabilityFitFrom maps 1 to exact, 0.5 to same_day and anything else to null', () => {
    expect(availabilityFitFrom({ availability: factor(1) })).toBe('exact');
    expect(availabilityFitFrom({ availability: factor(0.5) })).toBe('same_day');
    expect(availabilityFitFrom({ availability: factor(0) })).toBeNull();
    expect(availabilityFitFrom({ availability: factor(1, false) })).toBeNull();
    expect(availabilityFitFrom(null)).toBeNull();
  });
});
