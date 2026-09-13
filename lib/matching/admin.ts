/**
 * Spec 017 §3 — the admin surfaces: explainability (AC-6), weight configuration (AC-2), and the
 * AI-suggestion review workflow (AC-7).
 *
 * Every function here authorizes through spec 009's `resolvePermission`, never an ad-hoc role
 * string check — the same gate spec 010's catalog admin code uses.
 */
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { matchingSuggestions, providerProfiles, requestProviderMatches, requests, services } from '@/lib/db/schema';
import { resolvePermission } from '@/lib/admin-rbac/permissions';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';
import {
  matchingNotFoundError,
  matchingVersionConflictError,
  suggestionAlreadyReviewedError,
} from './errors';
import { effectivePoolSize, effectiveWeights, validateMatchingWeights, validatePoolSize } from './weights';
import { SCORE_MICROS_SCALE } from './ranking';
import type {
  ExclusionReason,
  MatchExplainabilityDto,
  MatchingSuggestionDto,
  MatchingSuggestionStatus,
  MatchingWeights,
  MatchingWeightsDto,
  ProviderResponse,
  ScoreBreakdown,
  UpdateMatchingWeightsRequest,
} from '@/lib/types/matching';

/** Spec 009 resource/action pair for every matching-admin operation. */
export const MATCHING_RESOURCE = 'matching.config';

async function requireMatchingPermission(userId: string, action: string): Promise<void> {
  const perm = await resolvePermission(userId, MATCHING_RESOURCE, action);
  if (!perm.allowed) throw adminForbiddenError();
}

/**
 * AC-6 — admin explainability. Returns which providers were excluded and why, plus the ranking
 * breakdown for those who were not.
 *
 * **This is the ONLY place scores, breakdowns and exclusion reasons are ever exposed.** No
 * provider- or customer-facing DTO in this spec carries them: a provider learning why a competitor
 * was excluded, or what a competitor scored, is a competitive-intelligence leak.
 */
export async function getMatchExplainability(userId: string, requestId: string): Promise<MatchExplainabilityDto> {
  await requireMatchingPermission(userId, 'read');

  const db = getDb();
  const [request] = await db
    .select({ id: requests.id, serviceId: requests.serviceId })
    .from(requests)
    .where(eq(requests.id, requestId));
  if (!request) throw matchingNotFoundError('The requested request does not exist.');

  const [service] = await db
    .select({ matchingWeights: services.matchingWeights, matchingPoolSize: services.matchingPoolSize })
    .from(services)
    .where(eq(services.id, request.serviceId));

  const rows = await db
    .select({
      providerProfileId: requestProviderMatches.providerProfileId,
      businessName: providerProfiles.businessName,
      eligible: requestProviderMatches.eligible,
      exclusionReason: requestProviderMatches.exclusionReason,
      rank: requestProviderMatches.rank,
      scoreMicros: requestProviderMatches.scoreMicros,
      scoreBreakdown: requestProviderMatches.scoreBreakdown,
      explorationBoosted: requestProviderMatches.explorationBoosted,
      notifiedAt: requestProviderMatches.notifiedAt,
      providerResponse: requestProviderMatches.providerResponse,
      createdAt: requestProviderMatches.createdAt,
    })
    .from(requestProviderMatches)
    .innerJoin(providerProfiles, eq(providerProfiles.id, requestProviderMatches.providerProfileId))
    .where(eq(requestProviderMatches.requestId, requestId))
    .orderBy(asc(requestProviderMatches.rank));

  const eligiblePool = rows
    .filter((row) => row.eligible)
    .map((row) => ({
      providerProfileId: row.providerProfileId,
      businessName: row.businessName,
      rank: row.rank ?? 0,
      score: (row.scoreMicros ?? 0) / SCORE_MICROS_SCALE,
      scoreBreakdown: (row.scoreBreakdown ?? {}) as ScoreBreakdown,
      explorationBoosted: row.explorationBoosted,
      notified: row.notifiedAt !== null,
      providerResponse: row.providerResponse as ProviderResponse,
    }));

  return {
    requestId,
    rankedAt: rows.length > 0 ? rows[0]!.createdAt.toISOString() : null,
    eligiblePool,
    excluded: rows
      .filter((row) => !row.eligible)
      .map((row) => ({
        providerProfileId: row.providerProfileId,
        businessName: row.businessName,
        reason: row.exclusionReason as ExclusionReason,
      })),
    notifiedProviderProfileIds: rows.filter((row) => row.notifiedAt !== null).map((row) => row.providerProfileId),
    poolSize: effectivePoolSize(service?.matchingPoolSize),
    effectiveWeights: effectiveWeights(service?.matchingWeights),
  };
}

export async function getMatchingWeights(userId: string, serviceId: string): Promise<MatchingWeightsDto> {
  await requireMatchingPermission(userId, 'read');
  return readWeightsDto(serviceId);
}

async function readWeightsDto(serviceId: string): Promise<MatchingWeightsDto> {
  const [service] = await getDb()
    .select({
      id: services.id,
      matchingWeights: services.matchingWeights,
      matchingPoolSize: services.matchingPoolSize,
      version: services.version,
    })
    .from(services)
    .where(eq(services.id, serviceId));
  if (!service) throw matchingNotFoundError('The requested service does not exist.');

  return {
    serviceId: service.id,
    weights: (service.matchingWeights as MatchingWeights | null) ?? null,
    effectiveWeights: effectiveWeights(service.matchingWeights),
    poolSize: service.matchingPoolSize,
    effectivePoolSize: effectivePoolSize(service.matchingPoolSize),
    version: service.version,
  };
}

/**
 * AC-2 — `PATCH /admin/services/{id}/matching-weights`. Weights must total exactly 100 and the
 * pool size must fall within 1–50; both are validated here and by database CHECK constraints.
 *
 * Passing `null` clears the override so the service falls back to the platform defaults.
 */
export async function updateMatchingWeights(
  userId: string,
  serviceId: string,
  body: UpdateMatchingWeightsRequest,
): Promise<MatchingWeightsDto> {
  await requireMatchingPermission(userId, 'configure');

  const db = getDb();
  const [current] = await db
    .select({ id: services.id, version: services.version })
    .from(services)
    .where(eq(services.id, serviceId));
  if (!current) throw matchingNotFoundError('The requested service does not exist.');
  if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) {
    throw matchingVersionConflictError(current.version);
  }

  const patch: Record<string, unknown> = { updatedAt: new Date(), version: current.version + 1 };
  if (body.weights !== undefined) {
    patch.matchingWeights = body.weights === null ? null : validateMatchingWeights(body.weights);
  }
  if (body.poolSize !== undefined) {
    patch.matchingPoolSize = body.poolSize === null ? null : validatePoolSize(body.poolSize);
  }

  await db.update(services).set(patch).where(eq(services.id, serviceId));
  return readWeightsDto(serviceId);
}

function toSuggestionDto(row: {
  id: string;
  serviceId: string | null;
  suggestedWeights: unknown;
  rationale: string | null;
  source: string;
  status: string;
  reviewedAt: Date | null;
  createdAt: Date;
}): MatchingSuggestionDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    suggestedWeights: row.suggestedWeights as MatchingWeights,
    rationale: row.rationale,
    source: row.source,
    status: row.status as MatchingSuggestionStatus,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const SUGGESTION_COLUMNS = {
  id: matchingSuggestions.id,
  serviceId: matchingSuggestions.serviceId,
  suggestedWeights: matchingSuggestions.suggestedWeights,
  rationale: matchingSuggestions.rationale,
  source: matchingSuggestions.source,
  status: matchingSuggestions.status,
  reviewedAt: matchingSuggestions.reviewedAt,
  createdAt: matchingSuggestions.createdAt,
} as const;

export async function listMatchingSuggestions(
  userId: string,
  page: { limit: number; offset: number },
): Promise<{ items: MatchingSuggestionDto[]; total: number }> {
  await requireMatchingPermission(userId, 'read');

  const db = getDb();
  const rows = await db
    .select(SUGGESTION_COLUMNS)
    .from(matchingSuggestions)
    .orderBy(desc(matchingSuggestions.createdAt))
    .limit(page.limit)
    .offset(page.offset);

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matchingSuggestions);

  return { items: rows.map(toSuggestionDto), total: Number(count) };
}

/**
 * AC-7 — records an AI-proposed weight change **for review**. This is the ONLY way a suggestion
 * enters the system, and it writes nothing but a `pending_review` row: there is deliberately no
 * code path from here to `services.matching_weights`.
 *
 * Called by an internal service boundary (the AI assistant, specs 033–036), not by an HTTP route —
 * exactly as spec 010's `catalog_suggestions` are produced.
 *
 * The suggested weights are validated on the way in, so an admin can never be shown, or approve,
 * a set that would be rejected as invalid configuration.
 */
export async function recordMatchingSuggestion(input: {
  serviceId?: string | null;
  suggestedWeights: unknown;
  rationale?: string | null;
  source: string;
}): Promise<MatchingSuggestionDto> {
  const weights = validateMatchingWeights(input.suggestedWeights, 'suggestedWeights');

  const [row] = await getDb()
    .insert(matchingSuggestions)
    .values({
      serviceId: input.serviceId ?? null,
      suggestedWeights: weights,
      rationale: input.rationale ?? null,
      source: input.source,
      status: 'pending_review',
    })
    .returning(SUGGESTION_COLUMNS);

  return toSuggestionDto(row!);
}

/**
 * AC-7 — approval is the ONLY path by which a suggestion's weights can reach live configuration,
 * and it requires an explicit, permission-checked admin action. The write is audited on the
 * suggestion row (`reviewed_by`, `reviewed_at`), the same audit fields `catalog_suggestions` uses.
 */
export async function approveMatchingSuggestion(userId: string, suggestionId: string): Promise<MatchingSuggestionDto> {
  await requireMatchingPermission(userId, 'configure');

  return getDb().transaction(async (tx) => {
    const [suggestion] = await tx
      .select({
        id: matchingSuggestions.id,
        serviceId: matchingSuggestions.serviceId,
        suggestedWeights: matchingSuggestions.suggestedWeights,
        status: matchingSuggestions.status,
      })
      .from(matchingSuggestions)
      .where(eq(matchingSuggestions.id, suggestionId));
    if (!suggestion) throw matchingNotFoundError('The requested suggestion does not exist.');
    if (suggestion.status !== 'pending_review') throw suggestionAlreadyReviewedError();

    const weights = validateMatchingWeights(suggestion.suggestedWeights, 'suggestedWeights');
    const reviewedAt = new Date();

    // A suggestion scoped to one service applies to that service. A platform-wide suggestion
    // (`service_id` null) is recorded as reviewed but applies to NO service automatically —
    // changing the platform defaults is a code change, never a runtime write.
    if (suggestion.serviceId) {
      await tx
        .update(services)
        .set({ matchingWeights: weights, updatedAt: reviewedAt, version: sql`${services.version} + 1` })
        .where(eq(services.id, suggestion.serviceId));
    }

    const [updated] = await tx
      .update(matchingSuggestions)
      .set({ status: 'approved', reviewedAt, reviewedBy: userId, updatedAt: reviewedAt })
      .where(and(eq(matchingSuggestions.id, suggestionId), eq(matchingSuggestions.status, 'pending_review')))
      .returning(SUGGESTION_COLUMNS);
    if (!updated) throw suggestionAlreadyReviewedError();

    return toSuggestionDto(updated);
  });
}

export async function rejectMatchingSuggestion(userId: string, suggestionId: string): Promise<MatchingSuggestionDto> {
  await requireMatchingPermission(userId, 'configure');

  const reviewedAt = new Date();
  const [updated] = await getDb()
    .update(matchingSuggestions)
    .set({ status: 'rejected', reviewedAt, reviewedBy: userId, updatedAt: reviewedAt })
    .where(and(eq(matchingSuggestions.id, suggestionId), eq(matchingSuggestions.status, 'pending_review')))
    .returning(SUGGESTION_COLUMNS);

  if (!updated) {
    const [exists] = await getDb()
      .select({ id: matchingSuggestions.id })
      .from(matchingSuggestions)
      .where(eq(matchingSuggestions.id, suggestionId));
    throw exists ? suggestionAlreadyReviewedError() : matchingNotFoundError('The requested suggestion does not exist.');
  }

  return toSuggestionDto(updated);
}

export { isNotNull };
