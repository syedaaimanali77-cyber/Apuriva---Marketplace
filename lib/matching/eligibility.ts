/**
 * Spec 017 §3 "Hard eligibility rules" (AC-1) — rules E1–E5.
 *
 * Evaluated in order and SHORT-CIRCUITING on the first failure, **before any score is computed**.
 * An excluded provider never reaches `lib/matching/ranking.ts` at all, which is what AC-1's
 * "excluded before ranking ever runs" means operationally.
 *
 * E2 and E3 reuse spec 016's approved helpers and duplicate none of that logic — spec 016 §7
 * already records this split: "the hard eligibility check is this spec's concern; the ranking
 * weight is spec 017's."
 */
import { isProviderEligibleForLocation, type EligibilityCandidate } from '@/lib/availability/service-areas';
import {
  availabilityFitAt,
  availabilityFitUnscheduled,
  type AvailabilityFit,
} from './availability-eligibility';
import type { ExclusionReason } from '@/lib/types/matching';

export interface EligibilityInput {
  providerProfileId: string;
  /** `provider_profiles.lifecycle_status` (spec 006). */
  lifecycleStatus: string;
  /** `provider_profiles.scheduling_timezone` (spec 016). */
  schedulingTimezone: string;
  /** Whether a `provider_services` row exists for this (provider, service). */
  offersService: boolean;
  /** The service's configured duration for this provider (spec 016 `provider_services`). */
  durationMinutes: number;
}

export interface EligibilityContext {
  serviceId: string;
  /** The request's origin, from spec 016's `candidateForRequest()`. */
  candidate: EligibilityCandidate;
  /** `requests.preferred_at` — null when the customer stated no time (spec 015). */
  preferredAt: Date | null;
}

export type EligibilityOutcome =
  | { eligible: true; availabilityFit: AvailabilityFit }
  | { eligible: false; reason: ExclusionReason };

/**
 * Rule E4 — verification status. The repository has **no separate verification entity**: no
 * `verified` boolean and no verification-documents table. `provider_profiles.lifecycle_status` is
 * the only status, and its `pending_verification` value is what "not yet verified" means today.
 */
export function isVerified(lifecycleStatus: string): boolean {
  return lifecycleStatus === 'active';
}

/**
 * Rule E5 — capacity. **A documented no-op this release (spec 017 DECIDED-1).**
 *
 * The repository has no capacity concept at all: no column, table or setting bounds how much work
 * a provider may hold. Rather than invent one, this function exists as a named, testable seam that
 * always returns eligible, so AC-1's fifth rule has a visible home and a future capacity model
 * lands here without touching any caller.
 *
 * `at_capacity` remains reserved in the `ExclusionReason` union but is **never returned** by this
 * function or any other code path in this release.
 */
export function evaluateCapacity(_input: EligibilityInput): { eligible: true } {
  return { eligible: true };
}

/**
 * AC-1 — the full gate. Returns the first failure, or eligibility plus the availability fit the
 * ranking stage reuses (so E3's work is not repeated during scoring).
 */
export async function evaluateEligibility(
  input: EligibilityInput,
  context: EligibilityContext,
): Promise<EligibilityOutcome> {
  // E1 — service match.
  if (!input.offersService) return { eligible: false, reason: 'service_not_offered' };

  // E2 — service area (spec 016; S2: no configured area = unrestricted).
  const inArea = await isProviderEligibleForLocation(input.providerProfileId, context.serviceId, context.candidate);
  if (!inArea) return { eligible: false, reason: 'outside_service_area' };

  // E3 — availability (spec 016, read-only; never `reserveProviderSlot`).
  const fit = context.preferredAt
    ? await availabilityFitAt(input.providerProfileId, input.schedulingTimezone, context.preferredAt, input.durationMinutes)
    : await availabilityFitUnscheduled(input.providerProfileId);
  if (fit === 'none') return { eligible: false, reason: 'unavailable' };

  // E4 — verification status.
  if (!isVerified(input.lifecycleStatus)) return { eligible: false, reason: 'not_verified' };

  // E5 — capacity: a documented no-op this release (DECIDED-1). Kept as an explicit call so the
  // rule is visible in the pipeline rather than silently absent.
  evaluateCapacity(input);

  return { eligible: true, availabilityFit: fit };
}
