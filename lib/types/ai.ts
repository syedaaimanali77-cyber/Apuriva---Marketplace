/** Spec 033 §3.11 request/response types. Spec 040's `GET /admin/analytics/ai-usage` reuses
 * `AiUsageSummaryDto` rather than re-deriving usage. */

export interface AiUsageTotals {
  requests: number;
  tokens: number;
}

export interface AiCostAlertThresholds {
  dailyMinorUnits: number;
  monthlyMinorUnits: number;
  dailyTokens: number;
}

/**
 * Aggregate only (AC-6): no `userId`, no guest hash, no input fingerprint, no prompt and no
 * response. `estimatedCostMinorUnits` is derived at read time from `totalTokens` and the
 * configured rate, never stored — so correcting the rate corrects history.
 */
export interface AiUsageSummaryDto {
  /** ISO-8601, inclusive. */
  from: string;
  /** ISO-8601, exclusive. */
  to: string;
  /** Every accounted attempt, including rejected and cached ones. */
  totalRequests: number;
  succeededRequests: number;
  rejectedRequests: number;
  failedRequests: number;
  cachedRequests: number;
  totalTokens: number;
  estimatedCostMinorUnits: number;
  currencyCode: string;
  byTask: Record<string, AiUsageTotals>;
  byProvider: Record<string, AiUsageTotals>;
  costAlertThresholds: AiCostAlertThresholds;
}
