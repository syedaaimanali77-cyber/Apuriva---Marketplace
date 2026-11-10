/** Spec 033 §3.11 request/response types. Spec 040's `GET /admin/analytics/ai-usage` reuses
 * `AiUsageSummaryDto` rather than re-deriving usage. */
import type { AI_TASKS } from '@/lib/db/schema';

/**
 * Master spec §80.2's task list, minus voice transcription (no transcription provider exists —
 * spec 013 already receives voice as text). Derived here, in `lib/types/`, the way every other
 * shared union in this directory is (`BookingStatus`, `OfferStatus`, `DisputeStatus`); `lib/ai`
 * re-exports it so domain code keeps importing it from its own barrel.
 */
export type AiTask = (typeof AI_TASKS)[number];

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
  /**
   * A TOTAL map over the closed `AiTask` union (spec 033 §3.11): every task key is always
   * present, and one with no traffic in the range reports `{ requests: 0, tokens: 0 }` rather
   * than being absent. A zero row is a fact about the period; a missing key is an absence of
   * contract, and spec 040 reuses this DTO rather than re-deriving usage.
   */
  byTask: Record<AiTask, AiUsageTotals>;
  /** Open-ended by contrast: provider names are a registry, not a closed union, so a provider
   *  with no traffic in the range is simply absent. */
  byProvider: Record<string, AiUsageTotals>;
  costAlertThresholds: AiCostAlertThresholds;
}
