/**
 * Spec 040 §3.6 — the report formulas, one aggregate query each, over the window W = [from, to).
 *
 * Every function takes an `Executor` (production passes `getDb()`; a test passes its snapshot
 * transaction) and returns AGGREGATES ONLY (AC-3): no user id, name, contact data, search text,
 * ranking score or fraud signal is ever selected into a result. Nothing here writes.
 *
 * Sources are the authoritative transactional tables; `analytics_events` feeds only the funnel's
 * `discover` stage. Money is per currency and never summed across currencies (D-4).
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import { EXPLORATION_SHARE } from '@/lib/matching/fairness';
import { getProviderRatingAggregates } from '@/lib/reviews/aggregate';
import type { PageParams } from '@/lib/api/pagination';
import type {
  FunnelReportDto,
  MatchingFairnessDto,
  ProviderPerformanceDto,
  RetentionReportDto,
  RevenueReportDto,
  ServiceTrendsReportDto,
  SupplyDemandReportDto,
} from '@/lib/types/analytics';
import { previousRange, ratio, round, type ReportRange } from './range';

export const SUPPLY_DEMAND_LIMIT = 50;
export const SERVICE_TRENDS_LIMIT = 20;

function period(range: ReportRange) {
  return { periodStart: range.from.toISOString(), periodEnd: range.to.toISOString() };
}

const int = (value: unknown): number => Number(value ?? 0);

/** R1 — period counts per stage (not a cohort); `conversionFromPrevious` may exceed 1. */
export async function funnelReport(db: Executor, range: ReportRange): Promise<FunnelReportDto> {
  const { from, to } = range;
  const [row] = await queryRows<Record<string, number>>(
    db,
    sql`SELECT
          (SELECT count(*)::int FROM analytics_events
            WHERE event_type = 'search_performed' AND occurred_at >= ${from} AND occurred_at < ${to}) AS discover,
          (SELECT count(*)::int FROM requests WHERE created_at >= ${from} AND created_at < ${to}) AS request,
          (SELECT count(*)::int FROM offers WHERE sent_at >= ${from} AND sent_at < ${to}) AS offer,
          (SELECT count(*)::int FROM bookings WHERE created_at >= ${from} AND created_at < ${to}) AS booking,
          (SELECT count(*)::int FROM bookings_status_history
            WHERE to_status = 'completed' AND occurred_at >= ${from} AND occurred_at < ${to}) AS complete`,
  );
  const order = ['discover', 'request', 'offer', 'booking', 'complete'] as const;
  const stages = order.map((stage, i) => {
    const count = int(row?.[stage]);
    const previous = i === 0 ? null : int(row?.[order[i - 1]!]);
    return { stage, count, conversionFromPrevious: previous === null ? null : ratio(count, previous, 4) };
  });
  return { stages, ...period(range) };
}

/** R2 — per currency, over spec 024 earnings lines created in W. */
export async function revenueReport(db: Executor, range: ReportRange): Promise<RevenueReportDto> {
  const rows = await queryRows<Record<string, string | number>>(
    db,
    sql`SELECT gross_currency_code AS currency_code,
               count(*)::int AS line_count,
               coalesce(sum(gross_amount_minor_units), 0)::bigint AS gross,
               coalesce(sum(refunded_amount_minor_units), 0)::bigint AS refunds,
               coalesce(sum(fee_amount_minor_units), 0)::bigint AS fee,
               coalesce(sum(fee_reversal_amount_minor_units), 0)::bigint AS fee_reversal,
               coalesce(sum(net_amount_minor_units), 0)::bigint AS provider_net
          FROM provider_earnings_lines
         WHERE created_at >= ${range.from} AND created_at < ${range.to}
         GROUP BY gross_currency_code
         ORDER BY gross_currency_code`,
  );
  return {
    currencies: rows.map((r) => ({
      currencyCode: String(r.currency_code),
      lineCount: int(r.line_count),
      grossMinorUnits: int(r.gross),
      refundsMinorUnits: int(r.refunds),
      feeMinorUnits: int(r.fee),
      feeReversalMinorUnits: int(r.fee_reversal),
      netFeeMinorUnits: int(r.fee) - int(r.fee_reversal),
      providerNetMinorUnits: int(r.provider_net),
    })),
    ...period(range),
  };
}

/** R3 — demand in W vs the current active supply, per service. */
export async function supplyDemandReport(db: Executor, range: ReportRange): Promise<SupplyDemandReportDto> {
  const rows = await queryRows<{ service_id: string; service_name: string; demand: number; supply: number }>(
    db,
    sql`WITH demand AS (
          SELECT service_id, count(*)::int AS demand FROM requests
           WHERE created_at >= ${range.from} AND created_at < ${range.to} GROUP BY service_id
        ), supply AS (
          SELECT ps.service_id, count(DISTINCT ps.provider_profile_id)::int AS supply
            FROM provider_services ps
            JOIN provider_profiles pp ON pp.id = ps.provider_profile_id AND pp.lifecycle_status = 'active'
           GROUP BY ps.service_id
        )
        SELECT s.id AS service_id, s.name AS service_name,
               coalesce(d.demand, 0) AS demand, coalesce(p.supply, 0) AS supply
          FROM services s
          LEFT JOIN demand d ON d.service_id = s.id
          LEFT JOIN supply p ON p.service_id = s.id
         WHERE coalesce(d.demand, 0) > 0 OR coalesce(p.supply, 0) > 0
         ORDER BY coalesce(d.demand, 0) DESC, s.name ASC, s.id ASC
         LIMIT ${SUPPLY_DEMAND_LIMIT}`,
  );
  return {
    services: rows.map((r) => ({
      serviceId: r.service_id,
      serviceName: r.service_name,
      demand: int(r.demand),
      supply: int(r.supply),
      demandPerProvider: ratio(int(r.demand), int(r.supply), 2),
    })),
    ...period(range),
  };
}

/** R4 — per provider: exposure, response time, completion (spec 017/020 data) and rating (spec 029). */
export async function providerPerformanceReport(
  db: Executor,
  range: ReportRange,
  page: PageParams,
): Promise<{ rows: ProviderPerformanceDto[]; total: number }> {
  const { from, to } = range;
  const scope = sql`
    WITH matches AS (
      SELECT provider_profile_id,
             count(*)::int AS notifications,
             avg(EXTRACT(EPOCH FROM (responded_at - notified_at)) / 60.0)
               FILTER (WHERE responded_at IS NOT NULL) AS response_minutes
        FROM request_provider_matches
       WHERE notified_at >= ${from} AND notified_at < ${to}
       GROUP BY provider_profile_id
    ), totals AS (
      SELECT coalesce(sum(notifications), 0)::int AS all_notifications FROM matches
    ), booked AS (
      SELECT b.provider_profile_id,
             count(*) FILTER (WHERE c.booking_id IS NOT NULL)::int AS completed,
             count(*) FILTER (WHERE c.booking_id IS NULL AND b.status IN ('cancelled','failed'))::int AS failed_or_cancelled
        FROM bookings b
        LEFT JOIN (SELECT DISTINCT booking_id FROM bookings_status_history WHERE to_status = 'completed') c
          ON c.booking_id = b.id
       WHERE b.created_at >= ${from} AND b.created_at < ${to}
       GROUP BY b.provider_profile_id
    ), providers AS (
      SELECT provider_profile_id FROM matches UNION SELECT provider_profile_id FROM booked
    )`;
  const [counted] = await queryRows<{ total: number }>(db, sql`${scope} SELECT count(*)::int AS total FROM providers`);
  const rows = await queryRows<{
    provider_profile_id: string;
    notifications: number;
    all_notifications: number;
    response_minutes: string | number | null;
    completed: number;
    failed_or_cancelled: number;
  }>(
    db,
    sql`${scope}
        SELECT p.provider_profile_id,
               coalesce(m.notifications, 0) AS notifications,
               t.all_notifications,
               m.response_minutes,
               coalesce(b.completed, 0) AS completed,
               coalesce(b.failed_or_cancelled, 0) AS failed_or_cancelled
          FROM providers p
          CROSS JOIN totals t
          LEFT JOIN matches m ON m.provider_profile_id = p.provider_profile_id
          LEFT JOIN booked b ON b.provider_profile_id = p.provider_profile_id
         ORDER BY coalesce(m.notifications, 0) DESC, p.provider_profile_id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const ratings = await getProviderRatingAggregates(
    rows.map((r) => r.provider_profile_id),
    db,
  );
  return {
    total: int(counted?.total),
    rows: rows.map((r) => {
      const completed = int(r.completed);
      const rating = ratings.get(r.provider_profile_id);
      return {
        providerProfileId: r.provider_profile_id,
        notifications: int(r.notifications),
        exposureShare: ratio(int(r.notifications), int(r.all_notifications), 4) ?? 0,
        responseTimeMinutes: r.response_minutes === null ? null : round(Number(r.response_minutes), 1),
        completionRate: ratio(completed, completed + int(r.failed_or_cancelled), 4),
        averageRating: rating ? rating.average : null,
        ratingCount: rating ? rating.count : null,
      };
    }),
  };
}

/** R5 (AC-4) — spec 017 AC-3's exploration exposure, computed from `request_provider_matches`. */
export async function matchingFairnessReport(db: Executor, range: ReportRange): Promise<MatchingFairnessDto> {
  const [row] = await queryRows<{ notifications: number; boosted: number; providers: number; top_decile: number }>(
    db,
    sql`WITH per_provider AS (
          SELECT provider_profile_id, count(*)::int AS n,
                 count(*) FILTER (WHERE exploration_boosted)::int AS boosted
            FROM request_provider_matches
           WHERE notified_at >= ${range.from} AND notified_at < ${range.to}
           GROUP BY provider_profile_id
        ), ranked AS (
          SELECT n, row_number() OVER (ORDER BY n DESC, provider_profile_id) AS position,
                 count(*) OVER () AS providers
            FROM per_provider
        )
        SELECT coalesce((SELECT sum(n) FROM per_provider), 0)::int AS notifications,
               coalesce((SELECT sum(boosted) FROM per_provider), 0)::int AS boosted,
               (SELECT count(*) FROM per_provider)::int AS providers,
               coalesce((SELECT sum(n) FROM ranked WHERE position <= ceil(providers * 0.1)), 0)::int AS top_decile`,
  );
  const notifications = int(row?.notifications);
  return {
    notifications,
    boostedNotifications: int(row?.boosted),
    boostedShare: ratio(int(row?.boosted), notifications, 4),
    configuredExplorationCap: EXPLORATION_SHARE,
    distinctProvidersNotified: int(row?.providers),
    topDecileExposureShare: ratio(int(row?.top_decile), notifications, 4),
    ...period(range),
  };
}

/** R6 — customers active (≥ 1 request) in the previous equal window who are active again in W. */
export async function retentionReport(db: Executor, range: ReportRange): Promise<RetentionReportDto> {
  const previous = previousRange(range);
  const [row] = await queryRows<{ previous_active: number; current_active: number; retained: number }>(
    db,
    sql`WITH prev AS (
          SELECT DISTINCT customer_profile_id FROM requests
           WHERE created_at >= ${previous.from} AND created_at < ${previous.to}
        ), curr AS (
          SELECT DISTINCT customer_profile_id FROM requests
           WHERE created_at >= ${range.from} AND created_at < ${range.to}
        )
        SELECT (SELECT count(*) FROM prev)::int AS previous_active,
               (SELECT count(*) FROM curr)::int AS current_active,
               (SELECT count(*) FROM prev JOIN curr USING (customer_profile_id))::int AS retained`,
  );
  const previousActive = int(row?.previous_active);
  return {
    previousPeriodStart: previous.from.toISOString(),
    previousActiveCustomers: previousActive,
    currentActiveCustomers: int(row?.current_active),
    retainedCustomers: int(row?.retained),
    retentionRate: ratio(int(row?.retained), previousActive, 4),
    ...period(range),
  };
}

/** R7 — requests per service in W vs the previous equal window. */
export async function serviceTrendsReport(db: Executor, range: ReportRange): Promise<ServiceTrendsReportDto> {
  const previous = previousRange(range);
  const rows = await queryRows<{ service_id: string; service_name: string; current_requests: number; previous_requests: number }>(
    db,
    sql`SELECT s.id AS service_id, s.name AS service_name,
               count(*) FILTER (WHERE r.created_at >= ${range.from} AND r.created_at < ${range.to})::int AS current_requests,
               count(*) FILTER (WHERE r.created_at >= ${previous.from} AND r.created_at < ${previous.to})::int AS previous_requests
          FROM requests r
          JOIN services s ON s.id = r.service_id
         WHERE r.created_at >= ${previous.from} AND r.created_at < ${range.to}
         GROUP BY s.id, s.name
        HAVING count(*) FILTER (WHERE r.created_at >= ${range.from} AND r.created_at < ${range.to}) > 0
         ORDER BY current_requests DESC, s.name ASC, s.id ASC
         LIMIT ${SERVICE_TRENDS_LIMIT}`,
  );
  return {
    previousPeriodStart: previous.from.toISOString(),
    services: rows.map((r) => {
      const current = int(r.current_requests);
      const prior = int(r.previous_requests);
      return {
        serviceId: r.service_id,
        serviceName: r.service_name,
        currentRequests: current,
        previousRequests: prior,
        changeRate: ratio(current - prior, prior, 4),
      };
    }),
    ...period(range),
  };
}
