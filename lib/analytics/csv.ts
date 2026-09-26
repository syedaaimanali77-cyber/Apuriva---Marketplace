/**
 * Spec 040 §5 "CSV" — provider performance only. Built client-side from the rows the server already
 * returned to this authorized caller, so nothing new is exposed: the columns are exactly
 * `ProviderPerformanceDto`'s aggregate fields (no name, contact data or ranking score).
 */
import type { ProviderPerformanceDto } from '@/lib/types/analytics';

export const PROVIDER_PERFORMANCE_CSV_COLUMNS = [
  'providerProfileId',
  'notifications',
  'exposureShare',
  'responseTimeMinutes',
  'completionRate',
  'averageRating',
  'ratingCount',
] as const satisfies readonly (keyof ProviderPerformanceDto)[];

/** Every value is a uuid, a number or empty (null), so no quoting or escaping is ever needed. */
export function providerPerformanceCsv(rows: readonly ProviderPerformanceDto[]): string {
  const lines = rows.map((row) =>
    PROVIDER_PERFORMANCE_CSV_COLUMNS.map((key) => (row[key] === null ? '' : String(row[key]))).join(','),
  );
  return [PROVIDER_PERFORMANCE_CSV_COLUMNS.join(','), ...lines].join('\n');
}
