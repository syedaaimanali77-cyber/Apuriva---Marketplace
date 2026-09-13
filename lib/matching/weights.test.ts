import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  DEFAULT_MATCHING_POOL_SIZE,
  DEFAULT_MATCHING_WEIGHTS,
  MAX_MATCHING_POOL_SIZE,
  MIN_MATCHING_POOL_SIZE,
  effectivePoolSize,
  effectiveWeights,
  isRankingFactor,
  validateMatchingWeights,
  validatePoolSize,
} from './weights';

describe('lib/matching/weights (spec 017 DECIDED-2/DECIDED-3)', () => {
  it('DEFAULT_MATCHING_POOL_SIZE is 10, bounded 1..50', () => {
    expect(DEFAULT_MATCHING_POOL_SIZE).toBe(10);
    expect(MIN_MATCHING_POOL_SIZE).toBe(1);
    expect(MAX_MATCHING_POOL_SIZE).toBe(50);
  });

  describe('validateMatchingWeights', () => {
    it('accepts the platform defaults', () => {
      expect(validateMatchingWeights(DEFAULT_MATCHING_WEIGHTS)).toEqual(DEFAULT_MATCHING_WEIGHTS);
    });

    it('accepts any integer set summing to exactly 100', () => {
      const custom = {
        serviceMatch: 40,
        availability: 20,
        location: 10,
        rating: 10,
        reliability: 5,
        priceFit: 5,
        experience: 5,
        verification: 3,
        historicalPerformance: 2,
      };
      expect(validateMatchingWeights(custom)).toEqual(custom);
    });

    it('rejects a set missing a factor', () => {
      const { serviceMatch: _drop, ...incomplete } = DEFAULT_MATCHING_WEIGHTS;
      expect(() => validateMatchingWeights(incomplete)).toThrow(ApiRouteError);
      try {
        validateMatchingWeights(incomplete);
      } catch (err) {
        expect((err as ApiRouteError).code).toBe('INVALID_MATCHING_WEIGHTS');
        expect((err as ApiRouteError).status).toBe(422);
      }
    });

    it('rejects a non-integer or out-of-range weight', () => {
      expect(() => validateMatchingWeights({ ...DEFAULT_MATCHING_WEIGHTS, rating: 10.5 })).toThrow(ApiRouteError);
      expect(() => validateMatchingWeights({ ...DEFAULT_MATCHING_WEIGHTS, rating: -1 })).toThrow(ApiRouteError);
      expect(() => validateMatchingWeights({ ...DEFAULT_MATCHING_WEIGHTS, rating: 101 })).toThrow(ApiRouteError);
    });

    it('rejects an unknown key rather than silently ignoring it', () => {
      expect(() => validateMatchingWeights({ ...DEFAULT_MATCHING_WEIGHTS, notAFactor: 5 })).toThrow(ApiRouteError);
    });

    it('rejects a set that does not sum to exactly 100', () => {
      expect(() => validateMatchingWeights({ ...DEFAULT_MATCHING_WEIGHTS, rating: 11 })).toThrow(ApiRouteError);
    });

    it('rejects a non-object value', () => {
      expect(() => validateMatchingWeights(null)).toThrow(ApiRouteError);
      expect(() => validateMatchingWeights('weights')).toThrow(ApiRouteError);
      expect(() => validateMatchingWeights([])).toThrow(ApiRouteError);
    });
  });

  describe('validatePoolSize', () => {
    it('accepts the bounds inclusive', () => {
      expect(validatePoolSize(1)).toBe(1);
      expect(validatePoolSize(50)).toBe(50);
    });

    it('rejects 0, 51, and non-integers', () => {
      expect(() => validatePoolSize(0)).toThrow(ApiRouteError);
      expect(() => validatePoolSize(51)).toThrow(ApiRouteError);
      expect(() => validatePoolSize(5.5)).toThrow(ApiRouteError);
    });
  });

  describe('effectiveWeights / effectivePoolSize', () => {
    it('falls back to the platform defaults when no override is stored', () => {
      expect(effectiveWeights(null)).toEqual(DEFAULT_MATCHING_WEIGHTS);
      expect(effectiveWeights(undefined)).toEqual(DEFAULT_MATCHING_WEIGHTS);
      expect(effectivePoolSize(null)).toBe(DEFAULT_MATCHING_POOL_SIZE);
    });

    it('uses the stored override when present', () => {
      const stored = { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 };
      expect(effectiveWeights(stored)).toEqual(stored);
      expect(effectivePoolSize(25)).toBe(25);
    });
  });

  describe('isRankingFactor', () => {
    it('recognizes exactly the nine known factors', () => {
      expect(isRankingFactor('serviceMatch')).toBe(true);
      expect(isRankingFactor('historicalPerformance')).toBe(true);
      expect(isRankingFactor('somethingElse')).toBe(false);
    });
  });
});
