/**
 * Spec 017 §3 — the platform matching configuration and its validation.
 *
 * Both defaults below are **Product decisions** recorded in the approved spec (§8 DECIDED-2 and
 * DECIDED-3). They are deliberately not derived from anything: no value for either existed in the
 * master specification, the approved spec chain, or this repository, and inventing one would have
 * been a silent product decision.
 */
import { RANKING_FACTORS, type MatchingWeights, type RankingFactor } from '@/lib/types/matching';
import { invalidMatchingWeightsError, type FieldError } from './errors';

/**
 * Spec 017 DECIDED-2 — the platform default ranking weights. **Sum to exactly 100.**
 *
 * Note what these mean in practice today: six of the nine factors have no data source until specs
 * 018/020/028/029/031 ship (see `./ranking.ts` "missing data"), so only `serviceMatch` (25),
 * `availability` (20) and `location` (15) are available and the score is renormalized over their
 * weight sum of 60. `serviceMatch` is additionally constant 1.0 for every eligible provider,
 * because hard rule E1 already guarantees an exact service match — so **availability and location
 * are what actually order the pool at launch**. The remaining 40 points activate on their own as
 * each owning spec ships, with no code change here.
 */
export const DEFAULT_MATCHING_WEIGHTS: MatchingWeights = {
  serviceMatch: 25,
  availability: 20,
  location: 15,
  rating: 10,
  reliability: 10,
  priceFit: 5,
  experience: 5,
  verification: 5,
  historicalPerformance: 5,
};

/** Spec 017 DECIDED-3 — how many top-ranked providers are notified per request by default. */
export const DEFAULT_MATCHING_POOL_SIZE = 10;

/** Spec 017 DECIDED-3 — the bounds a per-service override must fall within. */
export const MIN_MATCHING_POOL_SIZE = 1;
export const MAX_MATCHING_POOL_SIZE = 50;

/** The invariant an admin-supplied weight set must satisfy. Integers summing to 100 avoid the
 *  floating-point drift a "must sum to 1.0" rule would invite, and make the admin UI legible. */
export const WEIGHTS_MUST_SUM_TO = 100;

/** Every factor present exactly once, each an integer 0–100, together summing to exactly 100. */
export function validateMatchingWeights(value: unknown, field = 'weights'): MatchingWeights {
  const errors: FieldError[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidMatchingWeightsError([{ field, message: 'must be an object mapping each ranking factor to an integer weight.' }]);
  }

  const record = value as Record<string, unknown>;
  const weights = {} as MatchingWeights;

  for (const factor of RANKING_FACTORS) {
    const raw = record[factor];
    if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > 100) {
      errors.push({ field: `${field}.${factor}`, message: 'is required and must be an integer from 0 to 100.' });
      continue;
    }
    weights[factor] = raw as number;
  }

  // An unknown key is rejected rather than ignored: silently dropping it would let an admin
  // believe they had configured something that has no effect.
  for (const key of Object.keys(record)) {
    if (!(RANKING_FACTORS as readonly string[]).includes(key)) {
      errors.push({ field: `${field}.${key}`, message: 'is not a known ranking factor.' });
    }
  }

  if (errors.length > 0) throw invalidMatchingWeightsError(errors);

  const total = RANKING_FACTORS.reduce((sum, factor) => sum + weights[factor], 0);
  if (total !== WEIGHTS_MUST_SUM_TO) {
    throw invalidMatchingWeightsError([
      { field, message: `must sum to exactly ${WEIGHTS_MUST_SUM_TO}; this set sums to ${total}.` },
    ]);
  }

  return weights;
}

export function validatePoolSize(value: unknown, field = 'poolSize'): number {
  if (!Number.isInteger(value) || (value as number) < MIN_MATCHING_POOL_SIZE || (value as number) > MAX_MATCHING_POOL_SIZE) {
    throw invalidMatchingWeightsError([
      { field, message: `must be an integer from ${MIN_MATCHING_POOL_SIZE} to ${MAX_MATCHING_POOL_SIZE}.` },
    ]);
  }
  return value as number;
}

/** A stored override, or the platform defaults when none is set (spec 017 §3). */
export function effectiveWeights(stored: Record<string, number> | null | undefined): MatchingWeights {
  if (!stored) return { ...DEFAULT_MATCHING_WEIGHTS };
  const out = {} as MatchingWeights;
  for (const factor of RANKING_FACTORS) {
    // A stored set is always complete (validation above guarantees it), but fall back per-factor
    // rather than trusting data written before this validation existed.
    out[factor] = Number.isInteger(stored[factor]) ? (stored[factor] as number) : DEFAULT_MATCHING_WEIGHTS[factor];
  }
  return out;
}

export function effectivePoolSize(stored: number | null | undefined): number {
  return stored ?? DEFAULT_MATCHING_POOL_SIZE;
}

export function isRankingFactor(value: string): value is RankingFactor {
  return (RANKING_FACTORS as readonly string[]).includes(value);
}
