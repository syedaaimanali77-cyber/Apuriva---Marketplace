import { describe, expect, it } from 'vitest';
import { EXPLORATION_SHARE, explorationSlotsFor, selectDistributionPool } from './fairness';
import type { ScoredCandidate } from './ranking';

function candidate(overrides: Partial<ScoredCandidate>): ScoredCandidate {
  return {
    providerProfileId: 'p',
    scoreMicros: 500_000,
    breakdown: {} as ScoredCandidate['breakdown'],
    providerCreatedAt: new Date('2026-01-01T00:00:00Z'),
    isNew: false,
    explorationBoosted: false,
    ...overrides,
  };
}

describe('lib/matching/fairness (spec 017 AC-3, DECIDED-4)', () => {
  it('EXPLORATION_SHARE is exactly 20%', () => {
    expect(EXPLORATION_SHARE).toBe(0.2);
  });

  describe('explorationSlotsFor — floor rounding, per the approved table', () => {
    const table: [number, number][] = [
      [1, 0],
      [4, 0],
      [5, 1],
      [10, 2],
      [12, 2],
      [50, 10],
    ];
    for (const [poolSize, expected] of table) {
      it(`pool of ${poolSize} reserves ${expected} slot(s)`, () => {
        expect(explorationSlotsFor(poolSize)).toBe(expected);
      });
    }
  });

  describe('selectDistributionPool', () => {
    it('notifies every eligible provider when the pool is not larger than poolSize (AC-4)', () => {
      const ranked = [candidate({ providerProfileId: 'a' }), candidate({ providerProfileId: 'b' })];
      const { notified, explorationBoostedIds } = selectDistributionPool(ranked, 10);
      expect(notified.map((c) => c.providerProfileId).sort()).toEqual(['a', 'b']);
      expect(explorationBoostedIds.size).toBe(0);
    });

    it('reserves slots for the highest-ranked NEW providers who did not already place organically', () => {
      // Pool of 10 -> 2 reserved slots, 8 organic. 12 candidates: top 8 by score are not new;
      // two new providers rank 9th/10th and should be pulled in via exploration.
      const organicTop = Array.from({ length: 8 }, (_, i) =>
        candidate({ providerProfileId: `organic-${i}`, scoreMicros: 1_000_000 - i, isNew: false }),
      );
      const newProviders = Array.from({ length: 2 }, (_, i) =>
        candidate({ providerProfileId: `new-${i}`, scoreMicros: 500_000 - i, isNew: true }),
      );
      const stragglers = Array.from({ length: 2 }, (_, i) =>
        candidate({ providerProfileId: `straggler-${i}`, scoreMicros: 100_000 - i, isNew: false }),
      );

      const { notified, explorationBoostedIds } = selectDistributionPool(
        [...organicTop, ...newProviders, ...stragglers],
        10,
      );

      expect(notified).toHaveLength(10);
      expect(explorationBoostedIds).toEqual(new Set(['new-0', 'new-1']));
      // Stragglers (organic rank 11-12, not new) never make it in.
      expect(notified.some((c) => c.providerProfileId.startsWith('straggler'))).toBe(false);
    });

    it('a new provider who already ranks in the organic top-N is not double-counted as exploration', () => {
      // 10 candidates for a pool of 10: everyone is notified organically regardless of isNew.
      const ranked = Array.from({ length: 10 }, (_, i) =>
        candidate({ providerProfileId: `p-${i}`, scoreMicros: 1_000_000 - i, isNew: i < 3 }),
      );
      const { notified, explorationBoostedIds } = selectDistributionPool(ranked, 10);
      expect(notified).toHaveLength(10);
      // Exactly 10 eligible == poolSize -> the "notify all" branch, no exploration bookkeeping.
      expect(explorationBoostedIds.size).toBe(0);
    });

    it('unclaimed reserved slots fall back to the next organic candidates rather than shrinking the pool', () => {
      // Pool of 10, 2 reserved, but there are NO new providers at all — every slot must still fill
      // organically so the notified pool is exactly poolSize (assuming enough eligible candidates).
      const ranked = Array.from({ length: 15 }, (_, i) =>
        candidate({ providerProfileId: `p-${i}`, scoreMicros: 1_000_000 - i, isNew: false }),
      );
      const { notified, explorationBoostedIds } = selectDistributionPool(ranked, 10);
      expect(notified).toHaveLength(10);
      expect(explorationBoostedIds.size).toBe(0);
      // The top 10 by rank, since no exploration candidate existed to displace them.
      expect(notified.map((c) => c.providerProfileId)).toEqual(Array.from({ length: 10 }, (_, i) => `p-${i}`));
    });

    it('pools smaller than 5 reserve no slot even when new providers are present and the pool is exceeded', () => {
      const ranked = [
        candidate({ providerProfileId: 'organic-1', scoreMicros: 900_000, isNew: false }),
        candidate({ providerProfileId: 'organic-2', scoreMicros: 800_000, isNew: false }),
        candidate({ providerProfileId: 'organic-3', scoreMicros: 700_000, isNew: false }),
        candidate({ providerProfileId: 'new-1', scoreMicros: 100_000, isNew: true }),
      ];
      // poolSize 3 < 5 eligible providers -> exceeds the pool, but explorationSlotsFor(3) = 0.
      const { notified, explorationBoostedIds } = selectDistributionPool(ranked, 3);
      expect(notified).toHaveLength(3);
      expect(explorationBoostedIds.size).toBe(0);
      expect(notified.some((c) => c.providerProfileId === 'new-1')).toBe(false);
    });

    it('never alters scoreMicros for an exploration-boosted candidate — distribution only, per AC-3', () => {
      const organicTop = Array.from({ length: 8 }, (_, i) =>
        candidate({ providerProfileId: `organic-${i}`, scoreMicros: 900_000 - i }),
      );
      const newProvider = candidate({ providerProfileId: 'new-1', scoreMicros: 111_111, isNew: true });
      const { notified } = selectDistributionPool([...organicTop, newProvider], 10);
      const boosted = notified.find((c) => c.providerProfileId === 'new-1');
      expect(boosted?.scoreMicros).toBe(111_111);
    });
  });
});
