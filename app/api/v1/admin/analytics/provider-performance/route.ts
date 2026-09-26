import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { providerPerformanceReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/**
 * Spec 040 §3.5 R4 provider performance — exposure share, response time, completion rate and rating
 * per provider profile, paged. Carries no name, contact data or ranking score (AC-3, master §76).
 */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.readProviderPerformance, async (range, params, correlationId) => {
  const page = parsePageParams(params);
  const { rows, total } = await providerPerformanceReport(getDb(), range, page);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
