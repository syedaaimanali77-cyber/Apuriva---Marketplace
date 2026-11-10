/**
 * Spec 017 §3 "Hard eligibility rules" — the port through which rule E-block acquires a data
 * source, added by spec 030 (§3 "Blocking → matching", AC-1).
 *
 * WHAT THIS IS NOT. It is not a change to spec 017's ranking algorithm. `lib/matching/ranking.ts`
 * (scoring and renormalization) and `lib/matching/weights.ts` (the weights) are untouched, and no
 * factor gains or loses a point. A blocked provider is excluded at the HARD ELIGIBILITY stage,
 * before any score is computed — which is what AC-1's "excluded from matching" means operationally,
 * and it is where spec 017 already puts every other categorical exclusion.
 *
 * THE DEFAULT IS THE PRE-030 BEHAVIOUR. Unregistered, this returns an empty set — nobody is
 * blocked — which is exactly what spec 017 does today. Rolling spec 030 back therefore restores
 * spec 017 exactly, with no code change.
 *
 * This mirrors `registerBusyIntervalLoader` (spec 020 → 016) and `registerProviderRatingSource`
 * (spec 029 → 017), so the dependency stays strictly one-directional: `lib/matching/**` never
 * imports `lib/safety/**`.
 */

/**
 * Given the customer behind a request and a candidate pool, returns the subset of PROVIDER PROFILE
 * ids that must be excluded because of a block in either direction.
 *
 * Blocks are USER-scoped while matching candidates are PROVIDER-PROFILE-scoped, so resolving the
 * two is the source's job — done in one batched query rather than per candidate.
 */
export type ProviderBlockSource = (
  customerUserId: string,
  providerProfileIds: readonly string[],
) => Promise<ReadonlySet<string>>;

/** The pre-spec-030 default: with no blocking feature, nobody is blocked. */
const NONE_BLOCKED: ProviderBlockSource = async () => new Set<string>();

let currentSource: ProviderBlockSource = NONE_BLOCKED;

/** Called once by spec 030 at startup to make the port live against real blocks. */
export function registerProviderBlockSource(source: ProviderBlockSource): void {
  currentSource = source;
}

export function getProviderBlockSource(): ProviderBlockSource {
  return currentSource;
}

/** Restores the default. For tests that register a source and must not leak it to other suites. */
export function resetProviderBlockSource(): void {
  currentSource = NONE_BLOCKED;
}

/**
 * Consults the registered source. A source that THROWS is treated as "nobody blocked" and logged.
 *
 * This is the same polarity as `checkConversationBlock`, and for the same reason: a failure in the
 * blocking subsystem must never silently empty a customer's candidate pool and leave them unable to
 * be matched at all. The safe direction here is to under-exclude and log, because the block still
 * holds where it matters most — messaging — and a missed exclusion is visible to the customer,
 * whereas an empty pool looks like the platform is simply broken.
 */
export async function loadBlockedProviderProfileIds(
  customerUserId: string,
  providerProfileIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (providerProfileIds.length === 0) return new Set<string>();
  try {
    return await getProviderBlockSource()(customerUserId, providerProfileIds);
  } catch (err) {
    console.error(JSON.stringify({ event: 'matching.block_source_failed', error: String(err) }));
    return new Set<string>();
  }
}
