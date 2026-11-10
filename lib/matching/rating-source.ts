/**
 * Spec 017 §3 "Missing data" — the port through which the `rating` ranking factor acquires a data
 * source, added by spec 029 (§3 "Ranking").
 *
 * WHAT THIS IS NOT. It is not a change to spec 017's ranking algorithm. `lib/matching/ranking.ts`
 * (scoring and renormalization) and `lib/matching/weights.ts` (the weights) are untouched, and the
 * `rating` factor keeps its existing meaning and its existing 10 points. All that changes is that
 * `buildFactorInputs` can now be told a value instead of always emitting `null`.
 *
 * THE DEFAULT IS THE PRE-029 BEHAVIOUR. Unregistered, this returns `null` for every provider —
 * which is exactly what spec 017 emits today, and which `lib/matching/ranking.ts` excludes from both
 * the numerator and the denominator so that no provider is penalised for something nobody can
 * measure. Rolling spec 029 back therefore restores spec 017 exactly, with no code change.
 *
 * This mirrors `registerBusyIntervalLoader` in `lib/availability/busy-intervals.ts` — the same
 * shape spec 020 uses to supply occupied time to spec 016 — so the dependency stays strictly
 * one-directional: `lib/matching/**` never imports `lib/reviews/**`.
 */

/**
 * A normalized 0..1 score per provider profile id, or `null`/absent for "not yet rated".
 *
 * ABSENT AND ZERO ARE DIFFERENT and must stay that way: a provider with no reviews has no rating
 * signal (excluded from scoring), while a provider rated 1.0 across the board has a very poor one.
 * Collapsing the two would silently punish every new provider.
 */
export type ProviderRatingSource = (
  providerProfileIds: readonly string[],
) => Promise<Map<string, number | null>>;

/** The pre-spec-029 default: no provider has a rating, because none can be measured yet. */
const NO_RATINGS: ProviderRatingSource = async () => new Map();

let currentSource: ProviderRatingSource = NO_RATINGS;

/** Called once by spec 029 at startup to make the port live against real reviews. */
export function registerProviderRatingSource(source: ProviderRatingSource): void {
  currentSource = source;
}

export function getProviderRatingSource(): ProviderRatingSource {
  return currentSource;
}

/** Restores the default. For tests that register a source and must not leak it to other suites. */
export function resetProviderRatingSource(): void {
  currentSource = NO_RATINGS;
}
