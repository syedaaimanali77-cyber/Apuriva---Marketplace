/**
 * Spec 017 §3 "Ranking" (AC-2) — the scoring function.
 *
 * PURE and DETERMINISTIC by construction: it takes already-loaded values and returns a breakdown,
 * performing no I/O, reading no clock and using no randomness. Every rule below is therefore
 * unit-testable without a database, and the same inputs always produce the same order.
 */
import { RANKING_FACTORS, type FactorScore, type MatchingWeights, type RankingFactor, type ScoreBreakdown } from '@/lib/types/matching';

/** Spec 017 §3: distance at which the `location` factor decays to 0. */
export const LOCATION_DECAY_METERS = 50_000;

/** Score is persisted as an integer `score_micros` — score x 1,000,000 (spec 017 §4). */
export const SCORE_MICROS_SCALE = 1_000_000;

/**
 * A factor's raw input. `null` means **no data source exists yet** for this provider/factor — not
 * "zero". The distinction matters: see `scoreProvider`'s renormalization.
 */
export type FactorInput = number | null;

export type FactorInputs = Record<RankingFactor, FactorInput>;

/**
 * Spec 017 §3 — clamp to [0,1] then round HALF-UP to 3 decimal places.
 *
 * Half-up rather than JS's `Math.round` banker-ish behaviour on negatives, and fixed precision
 * rather than raw floats, so scoring is reproducible regardless of platform or the order in which
 * factors are summed.
 */
export function normalize(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round((clamped + Number.EPSILON) * 1000) / 1000;
}

/** Spec 017 §3 `location`: linear decay to 0 at `LOCATION_DECAY_METERS`. */
export function locationScore(distanceMeters: number): number {
  return normalize(1 - Math.min(distanceMeters / LOCATION_DECAY_METERS, 1));
}

/**
 * AC-2 — the weighted score and its per-factor breakdown.
 *
 * **Missing data (spec 017 §3).** A factor whose data source has not shipped contributes `null`
 * and is excluded from BOTH the numerator and the denominator; the score is renormalized over the
 * available weights only. A provider is therefore never penalised for a factor nobody can measure,
 * and switching a source on later changes ranking with no code change here.
 *
 * If NO factor is available, every eligible provider scores exactly 0.5 and tie-breaking alone
 * orders the pool — a defined outcome rather than a divide-by-zero.
 */
export function scoreProvider(
  inputs: FactorInputs,
  weights: MatchingWeights,
): { score: number; scoreMicros: number; breakdown: ScoreBreakdown } {
  const breakdown = {} as ScoreBreakdown;
  let weightedSum = 0;
  let availableWeight = 0;

  for (const factor of RANKING_FACTORS) {
    const raw = inputs[factor];
    const weight = weights[factor];
    const available = raw !== null && Number.isFinite(raw);
    const normalized = available ? normalize(raw as number) : 0;

    const entry: FactorScore = { normalized, weight, available };
    breakdown[factor] = entry;

    if (available) {
      weightedSum += normalized * weight;
      availableWeight += weight;
    }
  }

  const score = availableWeight === 0 ? 0.5 : weightedSum / availableWeight;
  return {
    score,
    // Rounded at the last possible moment, so no intermediate precision is lost.
    scoreMicros: Math.round(Math.min(1, Math.max(0, score)) * SCORE_MICROS_SCALE),
    breakdown,
  };
}

/** A scored candidate, ready to be ordered. */
export interface ScoredCandidate {
  providerProfileId: string;
  scoreMicros: number;
  breakdown: ScoreBreakdown;
  /** Tie-break input — the provider's registration instant. */
  providerCreatedAt: Date;
  /** Whether the provider has no terminal response yet (spec 017 AC-3). */
  isNew: boolean;
  explorationBoosted: boolean;
}

/**
 * Spec 017 §3 "Deterministic tie-breaking": `score_micros DESC`, then `explorationBoosted DESC`,
 * then `provider_profiles.created_at ASC`, then `provider_profiles.id ASC`.
 *
 * The final key is a primary key, so the ordering is TOTAL and STABLE — no randomness, no clock,
 * and no dependence on the order rows came back from the database.
 */
export function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.scoreMicros !== b.scoreMicros) return b.scoreMicros - a.scoreMicros;
  if (a.explorationBoosted !== b.explorationBoosted) return a.explorationBoosted ? -1 : 1;
  const createdDelta = a.providerCreatedAt.getTime() - b.providerCreatedAt.getTime();
  if (createdDelta !== 0) return createdDelta;
  return a.providerProfileId < b.providerProfileId ? -1 : a.providerProfileId > b.providerProfileId ? 1 : 0;
}

/** Orders a scored pool by the rule above. Returns a new array; never mutates the input. */
export function rankCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return [...candidates].sort(compareCandidates);
}
