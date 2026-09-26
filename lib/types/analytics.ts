/**
 * Spec 040 §3.8 — analytics event vocabulary and report DTOs. Every report is AGGREGATE-ONLY
 * (AC-3): no user id, name, contact data, search text, ranking score or fraud signal ever appears.
 */

export const ANALYTICS_EVENT_TYPES = [
  'search_performed',
  'request_submitted',
  'offer_accepted',
  'booking_completed',
  'review_submitted',
  'ai_conversation_started',
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export interface ReportPeriodDto {
  periodStart: string;
  periodEnd: string;
}

export const FUNNEL_STAGES = ['discover', 'request', 'offer', 'booking', 'complete'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Period counts, not a cohort — `conversionFromPrevious` can exceed 1 (§3.6). */
export interface FunnelReportDto extends ReportPeriodDto {
  stages: { stage: FunnelStage; count: number; conversionFromPrevious: number | null }[];
}

/** One currency's totals — never summed across currencies (§3.6, D-4). */
export interface RevenueCurrencyTotalsDto {
  currencyCode: string;
  lineCount: number;
  grossMinorUnits: number;
  refundsMinorUnits: number;
  feeMinorUnits: number;
  feeReversalMinorUnits: number;
  netFeeMinorUnits: number;
  providerNetMinorUnits: number;
}

export interface RevenueReportDto extends ReportPeriodDto {
  currencies: RevenueCurrencyTotalsDto[];
}

export interface SupplyDemandRowDto {
  serviceId: string;
  serviceName: string;
  demand: number;
  supply: number;
  demandPerProvider: number | null;
}

export interface SupplyDemandReportDto extends ReportPeriodDto {
  services: SupplyDemandRowDto[];
}

/** No name, no contact data and no ranking score (master §76). */
export interface ProviderPerformanceDto {
  providerProfileId: string;
  notifications: number;
  exposureShare: number;
  responseTimeMinutes: number | null;
  completionRate: number | null;
  averageRating: number | null;
  ratingCount: number | null;
}

export interface MatchingFairnessDto extends ReportPeriodDto {
  notifications: number;
  boostedNotifications: number;
  boostedShare: number | null;
  configuredExplorationCap: number;
  distinctProvidersNotified: number;
  topDecileExposureShare: number | null;
}

export interface RetentionReportDto extends ReportPeriodDto {
  previousPeriodStart: string;
  previousActiveCustomers: number;
  currentActiveCustomers: number;
  retainedCustomers: number;
  retentionRate: number | null;
}

export interface ServiceTrendRowDto {
  serviceId: string;
  serviceName: string;
  currentRequests: number;
  previousRequests: number;
  changeRate: number | null;
}

export interface ServiceTrendsReportDto extends ReportPeriodDto {
  previousPeriodStart: string;
  services: ServiceTrendRowDto[];
}
