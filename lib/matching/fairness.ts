/**
 * Spec 017 §3 "New-provider exploration" (AC-3) — fair exposure for providers with no history.
 *
 * Deterministic by construction: no randomness, no per-provider counters, no persistent state
 * beyond the `request_provider_matches` rows this spec already writes.
 */
import { rankCandidates, type ScoredCandidate } from './ranking';

/**
 * Spec 017 DECIDED-4 — the share of each distribution pool reserved for new providers.
 *
 * A **Product decision**: master spec §24 requires "limited exploration exposure" without
 * quantifying it, so no value could be derived. Setting this to 0 disables new-provider exposure
 * entirely, which is why this spec needs no feature flag (the `feature_flags` table is still spec
 * 003's column-less baseline and spec 041 owns making it real).
 */
export const EXPLORATION_SHARE = 0.2;

/**
 * Spec 017 §3 — how many of a pool of `poolSize` are reserved for new providers.
 *
 * **`floor`, always rounded down**, never up and never to nearest: 20% is a CAP, and rounding up
 * could exceed it. The consequence is intended — pools smaller than 5 reserve no slot at all,
 * because a single reserved slot in a pool of 1–4 would be 25–100% of that request's exposure,
 * far past the cap. New providers still compete organically in those pools; they are simply not
 * additionally boosted.
 */
export function explorationSlotsFor(poolSize: number): number {
  return Math.floor(poolSize * EXPLORATION_SHARE);
}

/**
 * AC-3 — selects the providers to notify: organic top-ranked, plus reserved slots for the
 * highest-ranked NEW providers who did not already place organically.
 *
 * Exploration affects DISTRIBUTION ONLY. It never alters `scoreMicros` (which stays purely
 * organic, so spec 040 can compare the boosted and organic populations honestly), and it never
 * touches hard eligibility — an ineligible new provider was already excluded before ranking and
 * never reaches this function.
 *
 * It also cannot become a permanent advantage: `isNew` is defined as "no terminal response yet"
 * (see `./repository.ts`), so it self-extinguishes on a provider's first accept/decline, and the
 * reserved share is a per-request ceiling with no cross-request memory or carry-over.
 */
export function selectDistributionPool(
  ranked: ScoredCandidate[],
  poolSize: number,
): { notified: ScoredCandidate[]; explorationBoostedIds: Set<string> } {
  const ordered = rankCandidates(ranked);

  // Fewer eligible providers than the pool size: notify all of them. Not an error, not a warning —
  // the normal case in a young marketplace. Exploration is moot when everyone is already notified.
  if (ordered.length <= poolSize) {
    return { notified: ordered, explorationBoostedIds: new Set() };
  }

  const reserved = explorationSlotsFor(poolSize);
  const organicCount = poolSize - reserved;
  const organic = ordered.slice(0, organicCount);
  const organicIds = new Set(organic.map((candidate) => candidate.providerProfileId));

  const explorationBoostedIds = new Set<string>();
  const explorers: ScoredCandidate[] = [];
  if (reserved > 0) {
    for (const candidate of ordered) {
      if (explorers.length >= reserved) break;
      if (!candidate.isNew || organicIds.has(candidate.providerProfileId)) continue;
      explorers.push({ ...candidate, explorationBoosted: true });
      explorationBoostedIds.add(candidate.providerProfileId);
    }
  }

  // Reserved slots that no new provider claimed fall back to the next organic candidates, so the
  // pool is never smaller than it could be. There is no carry-over to a future request.
  const shortfall = reserved - explorers.length;
  const filler = shortfall > 0 ? ordered.slice(organicCount).filter((c) => !explorationBoostedIds.has(c.providerProfileId)).slice(0, shortfall) : [];

  return { notified: [...organic, ...explorers, ...filler], explorationBoostedIds };
}
