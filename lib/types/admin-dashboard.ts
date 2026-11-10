/**
 * Spec 037 §3 "Request and response types" — the Admin Dashboard's three read-only DTOs.
 *
 * These are the CLOSED allow-list AC-4 relies on: every response is built field by field into one
 * of these shapes, so no developer-controlled setting (master spec §71) can ever reach a client.
 */

export interface MoneyAmountDto {
  amountMinorUnits: number;
  /** ISO 4217, taken from the source row — never assumed. */
  currencyCode: string;
}

export type AdminAlertSeverity = 'info' | 'warning' | 'critical';

/** Spec 037 §3 "Alert rules" — a closed set of exactly one rule. */
export type AdminAlertRule = 'critical_safety_reports';

export interface AdminAlertDto {
  rule: AdminAlertRule;
  severity: AdminAlertSeverity;
  count: number;
  /** Fixed text per rule; never user content. */
  message: string;
  /** An existing admin route. */
  linkTo: string;
}

export interface AdminOverviewDto {
  activeRequests: number;
  activeBookings: number;
  /**
   * GROSS CAPTURED customer payment amount for the current UTC calendar day, one entry per
   * currency (sorted by currencyCode); [] when nothing was captured. Refunds are NOT subtracted.
   * Not platform-fee revenue, not net revenue (spec 037 §3 "revenueToday").
   */
  revenueToday: MoneyAmountDto[];
  alerts: AdminAlertDto[];
  /** ISO 8601 server instant the figures were computed at — the UI's "as of". */
  generatedAt: string;
}

export type OperationsQueueItemType = 'dispute' | 'support_ticket' | 'safety_report';

export type OperationsQueuePriority = 'low' | 'medium' | 'high' | 'critical';

export interface OperationsQueueItemDto {
  type: OperationsQueueItemType;
  id: string;
  /** The source's own status value. */
  status: string;
  /** Disputes have no priority, so theirs is null. */
  priority: OperationsQueuePriority | null;
  /** ISO 8601. */
  createdAt: string;
  /** The existing detail route. */
  linkTo: string;
}

export interface MarketplaceMatchingConfigDto {
  /** Spec 017's DEFAULT_MATCHING_WEIGHTS (lib/matching/weights.ts) — a code constant, read-only. */
  platformDefaultWeights: Record<string, number>;
  /** Count of services whose services.matching_weights override is non-null. */
  serviceOverrideCount: number;
  linkTo: '/admin/marketplace/matching';
}

export interface MarketplaceCancellationConfigDto {
  /** The active platform-scope policy's open version (spec 023), or null if none exists. */
  activePlatformPolicy: { policyId: string; effectiveFrom: string; config: unknown } | null;
  /** Spec 023 assigns the configuration UI to spec 041 (Draft); no editor page exists yet. */
  linkTo: null;
}

export interface MarketplaceConfigDto {
  /** Present only when the caller holds matching.config/read. */
  matching?: MarketplaceMatchingConfigDto;
  /** Present only when the caller holds cancellation_policy/read. */
  cancellation?: MarketplaceCancellationConfigDto;
  generatedAt: string;
}
