import { apiSuccess } from '@/lib/api/response';
import { getDb } from '@/lib/db';
import { ANALYTICS_ACTIONS } from '@/lib/analytics/access';
import { retentionReport } from '@/lib/analytics/reports';
import { analyticsReportRoute } from '@/lib/analytics/route';

/** Spec 040 §3.5 R6 retention — customers active in the previous window and again in this one. Aggregates only (AC-3). */
export const GET = analyticsReportRoute(ANALYTICS_ACTIONS.read, async (range, _params, correlationId) =>
  apiSuccess(await retentionReport(getDb(), range), correlationId),
);
