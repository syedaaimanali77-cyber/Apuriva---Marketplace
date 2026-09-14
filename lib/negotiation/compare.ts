/**
 * Spec 019 §3 "Comparison" (AC-2, AC-6, AC-10, AC-11) — `GET /api/v1/requests/{id}/offers/compare`.
 *
 * Comparable = stored `sent`/`viewed` AND `clock_timestamp() < expires_at`, read in the same statement.
 * Top Match is derived at read time from spec 017's persisted `rank` — nothing is stored. The response
 * carries NO score, weight, breakdown value, rank number or exclusion reason (spec 017 AC-6): the stored
 * `score_breakdown` is consumed here only to derive categorical `availabilityFit` and reason codes.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { fromMicroDegrees, distanceMeters } from '@/lib/location/geo';
import { isVerified } from '@/lib/matching/eligibility';
import { approxKm } from '@/lib/matching/provider-requests';
import { loadProviderCenterPoints } from '@/lib/matching/repository';
import { queryRows } from '@/lib/offers/db';
import { assertCustomerOwnsRequest, markViewed } from '@/lib/offers/read';
import type { ComparedOfferDto, ComparisonUnavailableReason, OfferComparisonDto } from '@/lib/types/negotiation';
import { orderCanonically, parseOfferIdsParam, selectForComparison, topMatchOfferId, type ComparableCandidate } from './comparison';
import { offerNotComparableError, requestNotFoundError } from './errors';
import { COMPARISON_MIN_OFFERS } from './limits';
import { availabilityFitFrom, whyThisProvider } from './why-this-provider';

interface ComparableRow {
  offer_id: string;
  provider_profile_id: string;
  business_name: string | null;
  lifecycle_status: string;
  status: 'sent' | 'viewed';
  price_amount_minor_units: number;
  price_currency_code: string;
  included_items: string[];
  provider_message: string | null;
  estimated_duration_minutes: number | null;
  sent_at: Date;
  expires_at: Date;
  revision_number: number | null;
  previous_price_amount_minor_units: number | null;
  rank: number | null;
  score_breakdown: unknown;
}

type Candidate = ComparableCandidate & { row: ComparableRow };

async function loadComparable(requestId: string): Promise<Candidate[]> {
  const rows = await queryRows<ComparableRow>(
    getDb(),
    sql`SELECT o.id AS offer_id, o.provider_profile_id, pp.business_name, pp.lifecycle_status, o.status,
               o.price_amount_minor_units, o.price_currency_code, o.included_items, o.provider_message,
               o.estimated_duration_minutes, o.sent_at, o.expires_at,
               rv.revision_number, rv.previous_price_amount_minor_units, m.rank, m.score_breakdown
          FROM offers o
          JOIN provider_profiles pp ON pp.id = o.provider_profile_id
          LEFT JOIN request_provider_matches m ON m.request_id = o.request_id AND m.provider_profile_id = o.provider_profile_id
          LEFT JOIN offer_revisions rv ON rv.new_offer_id = o.id
         WHERE o.request_id = ${requestId} AND o.status IN ('sent', 'viewed') AND clock_timestamp() < o.expires_at`,
  );
  return rows.map((row) => ({ offerId: row.offer_id, rank: row.rank, sentAt: new Date(row.sent_at), row }));
}

export async function getOfferComparison(customerUserId: string, requestId: string, rawOfferIds: string | null): Promise<OfferComparisonDto> {
  await assertCustomerOwnsRequest(customerUserId, requestId);
  const requestedIds = parseOfferIdsParam(rawOfferIds);

  const [request] = await queryRows<{
    status: string;
    pricing_model: string;
    service_id: string;
    latitude: number | null;
    longitude: number | null;
    server_now: Date;
  }>(
    getDb(),
    sql`SELECT r.status, s.pricing_model, r.service_id,
               l.latitude_micro_degrees AS latitude, l.longitude_micro_degrees AS longitude,
               clock_timestamp() AS server_now
          FROM requests r
          JOIN services s ON s.id = r.service_id
          LEFT JOIN addresses a ON a.id = r.address_id
          LEFT JOIN locations l ON l.id = a.location_id
         WHERE r.id = ${requestId}`,
  );
  if (!request) throw requestNotFoundError();

  const unavailable = (reason: ComparisonUnavailableReason): OfferComparisonDto => {
    console.log(JSON.stringify({ event: 'negotiation.comparison_viewed', requestId, available: false, unavailableReason: reason, offerCount: 0 }));
    return { requestId, available: false, unavailableReason: reason, offers: [], maxOffers: 3, serverNow: new Date(request.server_now).toISOString() };
  };

  if (request.status !== 'offers_open') return unavailable('request_not_open_for_offers');
  if (request.pricing_model !== 'quote' && request.pricing_model !== 'custom') return unavailable('pricing_model_not_offer_based');

  const comparable = await loadComparable(requestId);
  const { selected, rejectedIds } = selectForComparison(comparable, requestedIds);
  if (requestedIds !== null && rejectedIds.length > 0) throw offerNotComparableError(rejectedIds);
  if (requestedIds === null && comparable.length < COMPARISON_MIN_OFFERS) return unavailable('fewer_than_two_comparable_offers');

  const topId = topMatchOfferId(comparable);

  // The owning customer's read of these offers (spec 018 `sent -> viewed`), then re-read for the truth.
  await markViewed(customerUserId, { offerIds: selected.map((candidate) => candidate.offerId) });
  const refreshed = new Map((await loadComparable(requestId)).map((candidate) => [candidate.offerId, candidate]));
  const finalRows = orderCanonically(selected.map((candidate) => refreshed.get(candidate.offerId) ?? candidate));

  const centers = await loadProviderCenterPoints(
    finalRows.map((candidate) => candidate.row.provider_profile_id),
    request.service_id,
  );
  const origin =
    request.latitude !== null && request.longitude !== null
      ? { latitude: fromMicroDegrees(request.latitude), longitude: fromMicroDegrees(request.longitude) }
      : null;

  const offers = finalRows.map(({ row }): ComparedOfferDto => {
    const center = centers.get(row.provider_profile_id);
    const isTopMatch = row.offer_id === topId;
    return {
      offerId: row.offer_id,
      providerProfileId: row.provider_profile_id,
      providerBusinessName: row.business_name,
      status: row.status,
      priceAmountMinorUnits: row.price_amount_minor_units,
      currencyCode: row.price_currency_code,
      previousPriceAmountMinorUnits: row.previous_price_amount_minor_units,
      revisionNumber: row.revision_number ?? 0,
      includedItems: row.included_items ?? [],
      providerMessage: row.provider_message,
      estimatedDurationMinutes: row.estimated_duration_minutes,
      availabilityFit: availabilityFitFrom(row.score_breakdown),
      approxDistanceKm: origin && center ? approxKm(distanceMeters(origin, center)) : null,
      rating: null,
      badges: isVerified(row.lifecycle_status) ? ['verified'] : [],
      isTopMatch,
      whyThisProvider: whyThisProvider(row.score_breakdown, isTopMatch),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  });

  console.log(JSON.stringify({ event: 'negotiation.comparison_viewed', requestId, available: true, unavailableReason: null, offerCount: offers.length }));
  return { requestId, available: true, unavailableReason: null, offers, maxOffers: 3, serverNow: new Date(request.server_now).toISOString() };
}
