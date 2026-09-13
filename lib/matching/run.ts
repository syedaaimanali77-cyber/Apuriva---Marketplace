/**
 * Spec 017 §3 — the matching pass: eligibility → ranking → bounded distribution (AC-1…AC-4).
 *
 * Idempotent by construction. The whole pass runs in one transaction and writes
 * `request_provider_matches` rows against the `(request_id, provider_profile_id)` unique index
 * that spec 003's baseline already provides, so re-running for the same request can neither
 * duplicate a row nor widen the notified set. Re-running is the documented recovery action.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  providerProfiles,
  providerServices,
  requestProviderMatches,
  requests,
  services,
} from '@/lib/db/schema';
import { candidateForRequest } from '@/lib/availability/service-areas';
import { distanceMeters, fromMicroDegrees } from '@/lib/location/geo';
import { availabilityFactorValue } from './availability-eligibility';
import { evaluateEligibility, type EligibilityInput } from './eligibility';
import { selectDistributionPool } from './fairness';
import { locationScore, rankCandidates, scoreProvider, type FactorInputs, type ScoredCandidate } from './ranking';
import { effectivePoolSize, effectiveWeights } from './weights';
import { matchingNotFoundError } from './errors';
import { loadProviderCenterPoints, loadTerminalResponderIds } from './repository';
import type { ExclusionReason, MatchingWeights } from '@/lib/types/matching';

export interface MatchingRunResult {
  requestId: string;
  eligibleCount: number;
  excludedCount: number;
  notifiedProviderProfileIds: string[];
  poolSize: number;
  effectiveWeights: MatchingWeights;
}

/**
 * Runs matching for a submitted request.
 *
 * AC-1: every candidate is gated by `evaluateEligibility` BEFORE any score is computed, and an
 * excluded candidate is written with its reason and a null rank/score — recorded, not merely
 * absent, which is what makes AC-6's explainability possible.
 */
export async function runMatching(requestId: string): Promise<MatchingRunResult> {
  const db = getDb();

  const [request] = await db
    .select({
      id: requests.id,
      status: requests.status,
      serviceId: requests.serviceId,
      preferredAt: requests.preferredAt,
      addressId: requests.addressId,
    })
    .from(requests)
    .where(eq(requests.id, requestId));
  if (!request) throw matchingNotFoundError('The requested request does not exist.');

  const [service] = await db
    .select({
      id: services.id,
      matchingWeights: services.matchingWeights,
      matchingPoolSize: services.matchingPoolSize,
    })
    .from(services)
    .where(eq(services.id, request.serviceId));
  if (!service) throw matchingNotFoundError('The request references a service that no longer exists.');

  const weights = effectiveWeights(service.matchingWeights);
  const poolSize = effectivePoolSize(service.matchingPoolSize);

  // Candidate set: every provider offering this service. E1 is therefore already satisfied for
  // everyone here, but it is still evaluated per candidate so the rule has one implementation.
  const candidates = await db
    .select({
      providerProfileId: providerProfiles.id,
      lifecycleStatus: providerProfiles.lifecycleStatus,
      schedulingTimezone: providerProfiles.schedulingTimezone,
      providerCreatedAt: providerProfiles.createdAt,
      durationMinutes: providerServices.durationMinutes,
    })
    .from(providerServices)
    .innerJoin(providerProfiles, eq(providerProfiles.id, providerServices.providerProfileId))
    .where(eq(providerServices.serviceId, request.serviceId));

  const origin = await candidateForRequest(requestId);
  const context = {
    serviceId: request.serviceId,
    candidate: origin ?? {},
    preferredAt: request.preferredAt ?? null,
  };

  const providerIds = candidates.map((c) => c.providerProfileId);
  const [centerPoints, terminalResponders] = await Promise.all([
    loadProviderCenterPoints(providerIds, request.serviceId),
    loadTerminalResponderIds(providerIds),
  ]);

  const excluded: Array<{ providerProfileId: string; reason: ExclusionReason }> = [];
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const input: EligibilityInput = {
      providerProfileId: candidate.providerProfileId,
      lifecycleStatus: candidate.lifecycleStatus,
      schedulingTimezone: candidate.schedulingTimezone,
      offersService: true,
      durationMinutes: candidate.durationMinutes,
    };

    const outcome = await evaluateEligibility(input, context);
    if (!outcome.eligible) {
      excluded.push({ providerProfileId: candidate.providerProfileId, reason: outcome.reason });
      continue;
    }

    const inputs = buildFactorInputs({
      availabilityFit: availabilityFactorValue(outcome.availabilityFit),
      originPoint: origin?.point,
      centerPoint: centerPoints.get(candidate.providerProfileId),
    });

    const { scoreMicros, breakdown } = scoreProvider(inputs, weights);
    scored.push({
      providerProfileId: candidate.providerProfileId,
      scoreMicros,
      breakdown,
      providerCreatedAt: candidate.providerCreatedAt,
      isNew: !terminalResponders.has(candidate.providerProfileId),
      explorationBoosted: false,
    });
  }

  const ranked = rankCandidates(scored);
  const { notified, explorationBoostedIds } = selectDistributionPool(ranked, poolSize);
  const notifiedIds = new Set(notified.map((c) => c.providerProfileId));
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const [index, candidate] of ranked.entries()) {
      await tx
        .insert(requestProviderMatches)
        .values({
          requestId,
          providerProfileId: candidate.providerProfileId,
          eligible: true,
          rank: index + 1,
          scoreMicros: candidate.scoreMicros,
          scoreBreakdown: candidate.breakdown,
          explorationBoosted: explorationBoostedIds.has(candidate.providerProfileId),
          notifiedAt: notifiedIds.has(candidate.providerProfileId) ? now : null,
        })
        // AC-4 idempotency: a second run must neither duplicate a row nor widen the notified set.
        .onConflictDoNothing({ target: [requestProviderMatches.requestId, requestProviderMatches.providerProfileId] });
    }

    for (const row of excluded) {
      await tx
        .insert(requestProviderMatches)
        .values({
          requestId,
          providerProfileId: row.providerProfileId,
          eligible: false,
          exclusionReason: row.reason,
        })
        .onConflictDoNothing({ target: [requestProviderMatches.requestId, requestProviderMatches.providerProfileId] });
    }

    // Spec 015's status machine: `submitted -> matching`, seeded by this spec's own migration.
    // The spec-003 DB trigger validates it independently. Only from `submitted`, so a re-run of an
    // already-matching request leaves the status alone rather than attempting an invalid write.
    if (request.status === 'submitted') {
      await tx
        .update(requests)
        .set({ status: 'matching', updatedAt: now })
        .where(and(eq(requests.id, requestId), eq(requests.status, 'submitted')));
    }
  });

  return {
    requestId,
    eligibleCount: ranked.length,
    excludedCount: excluded.length,
    notifiedProviderProfileIds: [...notifiedIds],
    poolSize,
    effectiveWeights: weights,
  };
}

/**
 * Spec 017 §3 "Missing data": a factor whose owning spec has not shipped contributes `null` — NOT
 * zero — so it is excluded from both the numerator and the denominator and no provider is
 * penalised for something nobody can measure.
 *
 * Today only `serviceMatch`, `availability` and `location` have a source. The other six activate
 * on their own as specs 018/020/028/029/031 land, with no change to this function's callers.
 */
function buildFactorInputs(args: {
  availabilityFit: number;
  originPoint?: { latitude: number; longitude: number };
  centerPoint?: { latitude: number; longitude: number };
}): FactorInputs {
  const canScoreLocation = Boolean(args.originPoint && args.centerPoint);
  return {
    // E1 guarantees an exact service match for every eligible provider, so this is constant 1.0
    // until adjacent/partial-service matching exists.
    serviceMatch: 1,
    availability: args.availabilityFit,
    location: canScoreLocation ? locationScore(distanceMeters(args.originPoint!, args.centerPoint!)) : null,
    // No data source yet — see the table in spec 017 §3.
    rating: null,
    reliability: null,
    priceFit: null,
    experience: null,
    verification: null,
    historicalPerformance: null,
  };
}

export { fromMicroDegrees, inArray, isNotNull, sql };
