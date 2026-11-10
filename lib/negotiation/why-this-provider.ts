/**
 * Spec 019 §3 "Why this provider" (AC-11). PURE and DETERMINISTIC: rule-based reason codes derived only
 * from spec 017's STORED `score_breakdown` snapshot and the Top Match flag. No AI, no free text, and no
 * number from the breakdown ever leaves this module (spec 017 AC-6).
 *
 * `serviceMatch` and `verification` produce no reason (constant across eligible providers, spec 017
 * risk 8); `rating`, `reliability`, `priceFit`, `experience` and `historicalPerformance` have no data
 * source today. BOUNDARY: a reason for any of them is added only by amending spec 019's table.
 */
import type { AvailabilityFit, WhyThisProviderReason } from '@/lib/types/negotiation';
import { NEARBY_MIN_LOCATION_SCORE } from './limits';

interface StoredFactor {
  normalized: number;
  available: boolean;
}

/** The stored jsonb is read defensively: anything malformed counts as "not available". */
function factor(breakdown: unknown, name: 'availability' | 'location'): StoredFactor | null {
  if (typeof breakdown !== 'object' || breakdown === null) return null;
  const entry = (breakdown as Record<string, unknown>)[name];
  if (typeof entry !== 'object' || entry === null) return null;
  const { normalized, available } = entry as { normalized?: unknown; available?: unknown };
  if (available !== true || typeof normalized !== 'number' || !Number.isFinite(normalized)) return null;
  return { normalized, available };
}

/** `availability.normalized` 1 → `exact`, 0.5 → `same_day`, anything else or unavailable → null. */
export function availabilityFitFrom(breakdown: unknown): AvailabilityFit | null {
  const availability = factor(breakdown, 'availability');
  if (!availability) return null;
  if (availability.normalized === 1) return 'exact';
  if (availability.normalized === 0.5) return 'same_day';
  return null;
}

/** Reason codes in the fixed order `top_match`, `available_at_requested_time`, `nearby`. */
export function whyThisProvider(breakdown: unknown, isTopMatch: boolean): WhyThisProviderReason[] {
  const reasons: WhyThisProviderReason[] = [];
  if (isTopMatch) reasons.push('top_match');
  if (availabilityFitFrom(breakdown) === 'exact') reasons.push('available_at_requested_time');
  const location = factor(breakdown, 'location');
  if (location && location.normalized >= NEARBY_MIN_LOCATION_SCORE) reasons.push('nearby');
  return reasons;
}
