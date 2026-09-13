import { describe, expect, it } from 'vitest';
import { compareCandidates, locationScore, normalize, rankCandidates, scoreProvider, type FactorInputs, type ScoredCandidate } from './ranking';
import { DEFAULT_MATCHING_WEIGHTS } from './weights';
import { RANKING_FACTORS } from '@/lib/types/matching';

/** A factor-inputs object with every factor `null` except the overrides given. */
function inputs(overrides: Partial<FactorInputs>): FactorInputs {
  const base = {} as FactorInputs;
  for (const factor of RANKING_FACTORS) base[factor] = null;
  return { ...base, ...overrides };
}

function candidate(overrides: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    providerProfileId: 'p-a',
    scoreMicros: 500_000,
    breakdown: {} as ScoredCandidate['breakdown'],
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    isNew: false,
    explorationBoosted: false,
    ...overrides,
  };
}

describe('lib/matching/ranking (spec 017 §3 AC-2)', () => {
  describe('DEFAULT_MATCHING_WEIGHTS (DECIDED-2)', () => {
    it('sums to exactly 100', () => {
      const total = RANKING_FACTORS.reduce((sum, f) => sum + DEFAULT_MATCHING_WEIGHTS[f], 0);
      expect(total).toBe(100);
    });

    it('matches the approved per-factor values exactly', () => {
      expect(DEFAULT_MATCHING_WEIGHTS).toEqual({
        serviceMatch: 25,
        availability: 20,
        location: 15,
        rating: 10,
        reliability: 10,
        priceFit: 5,
        experience: 5,
        verification: 5,
        historicalPerformance: 5,
      });
    });
  });

  describe('normalize', () => {
    it('clamps below 0 to 0 and above 1 to 1', () => {
      expect(normalize(-0.5)).toBe(0);
      expect(normalize(1.5)).toBe(1);
    });

    it('rounds half-up to 3 decimal places', () => {
      expect(normalize(0.1234)).toBe(0.123);
      expect(normalize(0.1235)).toBe(0.124);
      expect(normalize(0.99999)).toBe(1);
    });
  });

  describe('locationScore', () => {
    it('is 1.0 at zero distance and 0.0 at/beyond the 50km decay distance', () => {
      expect(locationScore(0)).toBe(1);
      expect(locationScore(50_000)).toBe(0);
      expect(locationScore(100_000)).toBe(0);
    });

    it('decays linearly at the midpoint', () => {
      expect(locationScore(25_000)).toBe(0.5);
    });
  });

  describe('scoreProvider — missing data and renormalization', () => {
    it('renormalizes over available factors only, excluding missing ones from numerator and denominator', () => {
      // Only serviceMatch (25) + availability (20) + location (15) available, weight sum 60 —
      // exactly the launch-day case spec 017 §3 documents.
      const { score, breakdown } = scoreProvider(
        inputs({ serviceMatch: 1, availability: 1, location: 1 }),
        DEFAULT_MATCHING_WEIGHTS,
      );
      expect(score).toBeCloseTo(1, 5);
      expect(breakdown.rating.available).toBe(false);
      expect(breakdown.serviceMatch.available).toBe(true);
    });

    it('a missing factor never penalises the score versus the same inputs with that factor unavailable', () => {
      const withoutLocation = scoreProvider(inputs({ serviceMatch: 1, availability: 1 }), DEFAULT_MATCHING_WEIGHTS);
      const withZeroLocation = scoreProvider(
        inputs({ serviceMatch: 1, availability: 1, location: 0 }),
        DEFAULT_MATCHING_WEIGHTS,
      );
      // Missing (renormalized away) scores strictly higher than an explicit 0 — proving "missing"
      // is not silently treated as "worst".
      expect(withoutLocation.score).toBeGreaterThan(withZeroLocation.score);
    });

    it('scores exactly 0.5 when NO factor is available — a defined outcome, not a divide-by-zero', () => {
      const { score, scoreMicros } = scoreProvider(inputs({}), DEFAULT_MATCHING_WEIGHTS);
      expect(score).toBe(0.5);
      expect(scoreMicros).toBe(500_000);
    });

    it('stores score_micros as an integer, score x 1,000,000, clamped to [0, 1000000]', () => {
      const { scoreMicros } = scoreProvider(inputs({ serviceMatch: 1, availability: 1, location: 1 }), DEFAULT_MATCHING_WEIGHTS);
      expect(Number.isInteger(scoreMicros)).toBe(true);
      expect(scoreMicros).toBe(1_000_000);
    });

    it('every factor appears in the breakdown even when unavailable, each with its configured weight', () => {
      const { breakdown } = scoreProvider(inputs({ serviceMatch: 1 }), DEFAULT_MATCHING_WEIGHTS);
      for (const factor of RANKING_FACTORS) {
        expect(breakdown[factor].weight).toBe(DEFAULT_MATCHING_WEIGHTS[factor]);
      }
    });
  });

  describe('deterministic tie-breaking (compareCandidates / rankCandidates)', () => {
    it('orders by score_micros DESC first', () => {
      const low = candidate({ providerProfileId: 'low', scoreMicros: 100 });
      const high = candidate({ providerProfileId: 'high', scoreMicros: 900 });
      expect(rankCandidates([low, high]).map((c) => c.providerProfileId)).toEqual(['high', 'low']);
    });

    it('breaks an exact score tie by explorationBoosted DESC', () => {
      const boosted = candidate({ providerProfileId: 'boosted', scoreMicros: 500, explorationBoosted: true });
      const organic = candidate({ providerProfileId: 'organic', scoreMicros: 500, explorationBoosted: false });
      expect(rankCandidates([organic, boosted]).map((c) => c.providerProfileId)).toEqual(['boosted', 'organic']);
    });

    it('then breaks by provider_profiles.created_at ASC (longest-registered first)', () => {
      const older = candidate({ providerProfileId: 'older', scoreMicros: 500, providerCreatedAt: new Date('2025-01-01') });
      const newer = candidate({ providerProfileId: 'newer', scoreMicros: 500, providerCreatedAt: new Date('2026-01-01') });
      expect(rankCandidates([newer, older]).map((c) => c.providerProfileId)).toEqual(['older', 'newer']);
    });

    it('finally breaks by provider_profiles.id ASC — a total, stable order with no remaining ties', () => {
      const sameDate = new Date('2026-01-01');
      const b = candidate({ providerProfileId: 'b-id', scoreMicros: 500, providerCreatedAt: sameDate });
      const a = candidate({ providerProfileId: 'a-id', scoreMicros: 500, providerCreatedAt: sameDate });
      expect(rankCandidates([b, a]).map((c) => c.providerProfileId)).toEqual(['a-id', 'b-id']);
    });

    it('does not mutate the input array', () => {
      const list = [candidate({ providerProfileId: 'x', scoreMicros: 1 }), candidate({ providerProfileId: 'y', scoreMicros: 2 })];
      const original = [...list];
      rankCandidates(list);
      expect(list).toEqual(original);
    });
  });

  it('compareCandidates is a valid total order consistent with rankCandidates', () => {
    const a = candidate({ providerProfileId: 'a', scoreMicros: 700 });
    const b = candidate({ providerProfileId: 'b', scoreMicros: 700, explorationBoosted: true });
    expect(compareCandidates(a, b)).toBeGreaterThan(0);
    expect(compareCandidates(b, a)).toBeLessThan(0);
    expect(compareCandidates(a, a)).toBe(0);
  });
});
