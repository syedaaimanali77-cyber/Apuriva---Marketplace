/**
 * Spec 017 §3 "Request and response types" — provider matching, ranking & distribution.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`, the same as
 * spec 012's `location.ts`, spec 015's `requests.ts` and spec 016's `availability.ts`.
 */
import type { RequestBudget } from './requests';
import type { CurrentOfferSummary } from './offers';

/** The nine master-spec §23 ranking factors, as a closed union — never a loose string key. */
export type RankingFactor =
  | 'serviceMatch'
  | 'availability'
  | 'location'
  | 'rating'
  | 'reliability'
  | 'priceFit'
  | 'experience'
  | 'verification'
  | 'historicalPerformance';

/** Declaration order is the canonical order — used for stable serialization and the admin UI. */
export const RANKING_FACTORS: readonly RankingFactor[] = [
  'serviceMatch',
  'availability',
  'location',
  'rating',
  'reliability',
  'priceFit',
  'experience',
  'verification',
  'historicalPerformance',
] as const;

export interface FactorScore {
  /** Normalized 0.000–1.000, 3 decimal places. */
  normalized: number;
  /** The weight applied, from the service override or the platform default. */
  weight: number;
  /** false when no data source exists yet for this factor — see §3 "Missing data". */
  available: boolean;
}

/** Every factor's normalized contribution. Strongly typed, replacing a `Record<string, number>`:
 *  the factor set is closed and known at compile time. */
export type ScoreBreakdown = Record<RankingFactor, FactorScore>;

export type MatchingWeights = Record<RankingFactor, number>;

export interface MatchingWeightsDto {
  serviceId: string;
  /** null = this service uses the platform defaults; no override of its own. */
  weights: MatchingWeights | null;
  effectiveWeights: MatchingWeights;
  /** null = this service uses `DEFAULT_MATCHING_POOL_SIZE`. */
  poolSize: number | null;
  effectivePoolSize: number;
  version: number;
}

export interface UpdateMatchingWeightsRequest {
  /** Omit to leave unchanged; null to clear the override and fall back to the defaults. */
  weights?: MatchingWeights | null;
  poolSize?: number | null;
  expectedVersion?: number;
}

export type ExclusionReason =
  | 'service_not_offered'
  | 'outside_service_area'
  | 'unavailable'
  | 'not_verified'
  /** Reserved (spec 017 DECIDED-1). E5 is a documented no-op this release, so nothing emits this. */
  | 'at_capacity'
  /**
   * Spec 030 (AC-1) — the requesting customer and this provider have blocked one another.
   * Supplied through `registerProviderBlockSource()`, whose default is "nobody blocked", so the
   * pre-030 behaviour is unchanged. Admin-only, like every other exclusion reason.
   */
  | 'blocked';

export type ProviderResponse = 'none' | 'accepted' | 'declined' | 'offer_sent';

export type AvailableAction = 'accept' | 'send_offer' | 'decline_only';

/**
 * ADMIN-ONLY (AC-6). Never returned by a provider- or customer-facing route: scores, breakdowns
 * and exclusion reasons are competitive intelligence about other providers.
 */
export interface MatchExplainabilityDto {
  requestId: string;
  rankedAt: string | null;
  eligiblePool: Array<{
    providerProfileId: string;
    businessName: string | null;
    rank: number;
    score: number;
    scoreBreakdown: ScoreBreakdown;
    explorationBoosted: boolean;
    notified: boolean;
    providerResponse: ProviderResponse;
  }>;
  excluded: Array<{ providerProfileId: string; businessName: string | null; reason: ExclusionReason }>;
  notifiedProviderProfileIds: string[];
  poolSize: number;
  effectiveWeights: MatchingWeights;
}

/** Returned to a provider ONLY for a request they were distributed into. */
export interface IncomingRequestDto {
  requestId: string;
  serviceId: string;
  serviceName: string;
  availableAction: AvailableAction;
  /** Coarse distance, never exact coordinates (spec 012 privacy). */
  approxDistanceKm: number | null;
  approxAreaLabel: string;
  description: string;
  urgency: 'normal' | 'urgent';
  budget: RequestBudget | null;
  preferredAt: string | null;
  distributedAt: string;
  providerResponse: ProviderResponse;
  /** Spec 018 §3: the caller's own most recent offer on this request (effective status), never another
   *  provider's. `null` when the provider has sent none. */
  currentOffer: CurrentOfferSummary | null;
}

export interface ProviderResponseDto {
  requestId: string;
  providerResponse: ProviderResponse;
  respondedAt: string;
}

export type MatchingSuggestionStatus = 'pending_review' | 'approved' | 'rejected';

export interface MatchingSuggestionDto {
  id: string;
  /** null = a proposed change to the platform defaults rather than one service. */
  serviceId: string | null;
  suggestedWeights: MatchingWeights;
  rationale: string | null;
  source: string;
  status: MatchingSuggestionStatus;
  reviewedAt: string | null;
  createdAt: string;
}
