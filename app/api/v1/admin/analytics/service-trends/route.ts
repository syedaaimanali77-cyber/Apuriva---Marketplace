import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { serviceTrendsReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R7 service trends — requests per service vs the previous window. Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.read, async (range, _params, correlationId) =>
  apiSuccess(await serviceTrendsReport(getDb(), range), correlationId),
);
