/**
 * Spec 019 §3 "Comparison" — the PURE parts (AC-10): `offerIds` parsing, canonical order, Top Match and
 * selection. No I/O, clock or randomness, so every rule is unit-tested; `compare.ts` does the reads.
 */
import { validationError } from '@/lib/api/errors';
import { isUuid } from '@/lib/offers/validation';
import { COMPARISON_MAX_OFFERS, COMPARISON_MIN_OFFERS } from './limits';
import { comparisonLimitExceededError } from './errors';

export interface ComparableCandidate {
  offerId: string;
  /** Spec 017's persisted `request_provider_matches.rank`. */
  rank: number | null;
  sentAt: Date;
}

/** `rank ASC` (nulls last), then `sent_at ASC`, then `offer id ASC` — a total order. */
export function compareCanonical(a: ComparableCandidate, b: ComparableCandidate): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank;
  }
  const sentDelta = a.sentAt.getTime() - b.sentAt.getTime();
  if (sentDelta !== 0) return sentDelta;
  return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
}

export function orderCanonically<T extends ComparableCandidate>(candidates: T[]): T[] {
  return [...candidates].sort(compareCanonical);
}

/** Exactly one Top Match: the first comparable offer in canonical order across ALL comparable offers. */
export function topMatchOfferId(candidates: ComparableCandidate[]): string | null {
  return orderCanonically(candidates)[0]?.offerId ?? null;
}

/**
 * `?offerIds=a,b,c`. Absent/empty → `null` (server picks). More than 3 → `422 COMPARISON_LIMIT_EXCEEDED`
 * (checked first); fewer than 2, a malformed id or a duplicate → `400 VALIDATION_ERROR`.
 */
export function parseOfferIdsParam(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === '') return null;
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.length > COMPARISON_MAX_OFFERS) throw comparisonLimitExceededError();
  if (ids.length < COMPARISON_MIN_OFFERS) {
    throw validationError([{ field: 'offerIds', message: `must list ${COMPARISON_MIN_OFFERS}–${COMPARISON_MAX_OFFERS} offer ids` }]);
  }
  if (ids.some((id) => !isUuid(id))) throw validationError([{ field: 'offerIds', message: 'must be valid offer ids' }]);
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw validationError([{ field: 'offerIds', message: 'must not contain duplicates' }]);
  }
  return ids;
}

/**
 * Chooses what to return, always in canonical order. With explicit ids, every id must be comparable;
 * `rejectedIds` lists only the ids the caller supplied that are not.
 */
export function selectForComparison<T extends ComparableCandidate>(
  comparable: T[],
  requestedIds: string[] | null,
): { selected: T[]; rejectedIds: string[] } {
  const ordered = orderCanonically(comparable);
  if (requestedIds === null) return { selected: ordered.slice(0, COMPARISON_MAX_OFFERS), rejectedIds: [] };
  const wanted = new Set(requestedIds.map((id) => id.toLowerCase()));
  const selected = ordered.filter((candidate) => wanted.has(candidate.offerId.toLowerCase()));
  const found = new Set(selected.map((candidate) => candidate.offerId.toLowerCase()));
  return { selected, rejectedIds: requestedIds.filter((id) => !found.has(id.toLowerCase())) };
}
